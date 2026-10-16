// Deleting a contact (admins), Settings → Recently deleted contacts (restore), the 14-day purge, and a deleted
// contact writing again. Needs the server running: API_URL, default http://localhost:5001
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prisma } from '../src/prisma.js';
import { RETENTION_DAYS, purgeDeletedContacts } from '../src/services/deletedContacts.js';

const API = process.env.API_URL ?? 'http://localhost:5001';
const run = Date.now();
async function gql(query: string, variables: object = {}, token?: string) {
  const res = await fetch(`${API}/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  const j = (await res.json()) as { data?: any; errors?: { message: string }[] };
  if (j.errors) throw new Error(j.errors[0].message);
  return j.data;
}
const REG = `mutation($i: RegisterInput!) { register(input: $i) { token user { id } workspace { id } } }`;
const SIM = `mutation($i: SimulateIncomingInput) { simulateIncomingMessage(input: $i) }`;
const LIST = `{ conversations { nodes { id contact { id } } } }`;

test('delete, hidden everywhere, restore, purge after 14 days, back when they write again', async () => {
  const o = (await gql(REG, { i: { name: 'Owner', email: `e2e-dc-o-${run}@example.com`, password: 'password123', workspaceName: `dc-${run}` } })).register;
  const { token: join } = (await gql(`mutation { createJoinLink { token } }`, {}, o.token)).createJoinLink;
  const a = (await gql(REG, { i: { name: 'Agent', email: `e2e-dc-a-${run}@example.com`, password: 'password123', joinToken: join } })).register;
  await gql(SIM, { i: { waId: '971505553001', name: 'Keep', body: 'hi' } }, o.token);
  await gql(SIM, { i: { waId: '971505553002', name: 'Gone', body: 'hello' } }, o.token);
  const convs = (await gql(LIST, {}, o.token)).conversations.nodes;
  const goneContact = (await prisma.contact.findFirstOrThrow({ where: { workspaceId: o.workspace.id, waId: '971505553002' } })).id;
  const goneConv = convs.find((c: any) => c.contact.id === goneContact).id;

  await assert.rejects(gql(`mutation($id: ID!) { deleteContact(id: $id) }`, { id: goneContact }, a.token), /admins/i);
  await gql(`mutation($id: ID!) { deleteContact(id: $id) }`, { id: goneContact }, o.token);
  // gone from the chat list, the chat and the contact; unread total drops
  assert.deepEqual((await gql(LIST, {}, o.token)).conversations.nodes.map((c: any) => c.contact.id).includes(goneContact), false);
  await assert.rejects(gql(`query($id: ID!) { contact(id: $id) { id } }`, { id: goneContact }, o.token), /not found/i);
  await assert.rejects(gql(`mutation($c: ID!) { sendTextMessage(input: { conversationId: $c, body: "x" }) { id } }`, { c: goneConv }, o.token), /not found/i);
  assert.equal((await gql(`{ unreadTotal }`, {}, o.token)).unreadTotal, 1);

  // the list (admins)
  await assert.rejects(gql(`{ deletedContacts { id } }`, {}, a.token), /admins/i);
  const del = (await gql(`{ deletedContacts { id name deletedByName deletedAt purgeAt } deletedContactsRetentionDays }`, {}, o.token));
  assert.equal(del.deletedContactsRetentionDays, RETENTION_DAYS);
  assert.deepEqual(del.deletedContacts.map((d: any) => [d.id, d.name, d.deletedByName]), [[goneContact, 'Gone', 'Owner']]);
  assert.equal(new Date(del.deletedContacts[0].purgeAt).getTime() - new Date(del.deletedContacts[0].deletedAt).getTime(), RETENTION_DAYS * 86_400_000);

  // restore
  await gql(`mutation($id: ID!) { restoreContact(id: $id) }`, { id: goneContact }, o.token);
  assert.ok((await gql(LIST, {}, o.token)).conversations.nodes.some((c: any) => c.contact.id === goneContact));
  assert.equal((await gql(`{ deletedContacts { id } }`, {}, o.token)).deletedContacts.length, 0);

  // deleted again, then the customer writes: back, with the new message
  await gql(`mutation($id: ID!) { deleteContact(id: $id) }`, { id: goneContact }, o.token);
  await gql(SIM, { i: { waId: '971505553002', name: 'Gone', body: 'are you there?' } }, o.token);
  assert.ok((await gql(LIST, {}, o.token)).conversations.nodes.some((c: any) => c.contact.id === goneContact));

  // purge: only contacts deleted more than 14 days ago (this one is backdated; a fresh deletion stays)
  await gql(`mutation($id: ID!) { deleteContact(id: $id) }`, { id: goneContact }, o.token);
  const keep = (await prisma.contact.findFirstOrThrow({ where: { workspaceId: o.workspace.id, waId: '971505553001' } })).id;
  await gql(`mutation($id: ID!) { deleteContact(id: $id) }`, { id: keep }, o.token);
  await prisma.contact.update({ where: { id: goneContact }, data: { deletedAt: new Date(Date.now() - (RETENTION_DAYS + 1) * 86_400_000) } });
  assert.ok((await purgeDeletedContacts()) >= 1);
  assert.equal(await prisma.contact.count({ where: { id: goneContact } }), 0);
  assert.equal(await prisma.conversation.count({ where: { id: goneConv } }), 0); // the chat went with it
  assert.equal(await prisma.contact.count({ where: { id: keep } }), 1); // deleted just now: still restorable
  await gql(`mutation($id: ID!) { restoreContact(id: $id) }`, { id: keep }, o.token);
  await prisma.$disconnect();
});
