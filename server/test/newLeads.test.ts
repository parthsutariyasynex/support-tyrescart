// New Leads: open chats nobody holds. A chat that is taken leaves New Leads; unassigned again, it's back at once;
// closed, snoozed and deleted contacts' chats are left out. The Inbox and its Unassigned filter still list
// everything; My Chats shows what is assigned to you. Uses the running API (API_URL).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { prisma } from '../src/prisma.js';

const API = process.env.API_URL ?? 'http://localhost:5001';
const run = Date.now();
async function gql(query: string, variables: object = {}, token?: string) {
  const res = await fetch(`${API}/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  const j = (await res.json()) as { data?: any; errors?: { message: string }[] };
  if (j.errors) throw new Error(j.errors[0].message);
  return j.data;
}
after(() => prisma.$disconnect());

test('New Leads: open, unassigned chats (unassigned ones come back at once); counts follow; Inbox and My Chats unchanged', async () => {
  const reg = `mutation($i: RegisterInput!) { register(input: $i) { token user { id } } }`;
  const o = (await gql(reg, { i: { name: `Owner ${run}`, email: `e2e-nl-o-${run}@example.com`, password: 'password123', workspaceName: `New leads ${run}` } })).register;
  const { token: join } = (await gql(`mutation { createJoinLink { token } }`, {}, o.token)).createJoinLink;
  const a = (await gql(reg, { i: { name: `Agent ${run}`, email: `e2e-nl-a-${run}@example.com`, password: 'password123', joinToken: join } })).register;

  // generated customers for this run
  const names = [1, 2, 3, 4, 5].map((n) => `Lead ${run.toString(36)} ${n}`);
  for (const [i, name] of names.entries())
    await gql(`mutation($i: SimulateIncomingInput) { simulateIncomingMessage(input: $i) }`, { i: { waId: `9715${String(run).slice(-7)}${i}`, name, body: 'Hi' } }, o.token);

  const list = async (assignee: string | null, token = a.token) =>
    (await gql(`query($a: ID) { conversations(assignee: $a, first: 100) { nodes { id status wasAssigned contact { id name } } } }`, { a: assignee }, token)).conversations.nodes as {
      id: string;
      status: string;
      wasAssigned: boolean;
      contact: { id: string; name: string };
    }[];
  const leadNames = async () => (await list('new_leads')).map((c) => c.contact.name).sort();
  const counts = async () => (await gql(`{ conversationCounts { unassigned newLeads open } }`, {}, a.token)).conversationCounts;
  const all = await list(null);
  const id = (n: number) => all.find((c) => c.contact.name === names[n - 1])!.id;

  assert.deepEqual(await leadNames(), [...names].sort());
  assert.equal((await counts()).newLeads, 5);
  assert.ok(all.every((c) => c.wasAssigned === false));

  // 1. the agent takes chat 1: it leaves New Leads and is in their My Chats
  await gql(`mutation($id: ID!) { claimConversation(conversationId: $id) { id } }`, { id: id(1) }, a.token);
  assert.ok(!(await leadNames()).includes(names[0]));
  assert.ok((await list('me')).some((c) => c.id === id(1)));

  // 2. unassigned again: back in New Leads at once (and still in the Inbox and its Unassigned filter)
  await gql(`mutation($c: ID!) { assignConversation(conversationId: $c, assigneeId: null, reason: "Customer will call back") { id } }`, { c: id(1) }, o.token);
  assert.ok((await leadNames()).includes(names[0]));
  assert.equal((await counts()).newLeads, 5);
  const released = (await list(null)).find((c) => c.id === id(1))!;
  assert.equal(released.wasAssigned, true);
  assert.ok((await list('unassigned')).some((c) => c.id === id(1)));
  assert.ok(!(await list('me')).some((c) => c.id === id(1))); // no longer the agent's

  // 3. closed or snoozed: not a new lead; reopened: it is again
  await gql(`mutation($id: ID!) { closeConversation(id: $id) { id } }`, { id: id(2) }, o.token);
  await gql(`mutation($id: ID!, $u: DateTime!) { snoozeConversation(id: $id, until: $u) { id } }`, { id: id(3), u: new Date(Date.now() + 3_600_000).toISOString() }, o.token);
  assert.deepEqual(await leadNames(), [names[0], names[3], names[4]].sort());
  await gql(`mutation($id: ID!) { reopenConversation(id: $id) { id } }`, { id: id(2) }, o.token);
  assert.deepEqual(await leadNames(), [names[0], names[1], names[3], names[4]].sort());

  // 4. a deleted contact's chat is in no list and no count
  const before = await counts();
  await gql(`mutation($id: ID!) { deleteContact(id: $id) }`, { id: all.find((c) => c.id === id(5))!.contact.id }, o.token);
  assert.deepEqual(await leadNames(), [names[0], names[1], names[3]].sort());
  const now = await counts();
  assert.equal(now.newLeads, 3);
  assert.equal(now.unassigned, before.unassigned - 1);
  assert.equal(now.open, before.open - 1);

  // counts match the lists
  assert.equal(now.newLeads, (await list('new_leads')).length);
  assert.equal(now.unassigned, (await list('unassigned')).length);

  // 5. the Inbox (no filter) still has every chat of this workspace except the deleted contact's
  assert.equal((await list(null)).length, 4);
});
