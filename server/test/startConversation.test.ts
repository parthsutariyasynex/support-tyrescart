// Start a new conversation: real numbers only, one contact and one chat per number (reused, never duplicated, even
// when started twice at the same moment), a deleted contact comes back, and a new chat reaches everyone live. Also
// the message length limits are WhatsApp's / the database's, not lower app ones. The API server must be running (API_URL).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import bcrypt from 'bcryptjs';
import { io as connectSocket } from 'socket.io-client';
import { prisma } from '../src/prisma.js';

const API = process.env.API_URL ?? 'http://localhost:5001';
const run = Date.now();
async function gql(query: string, variables: object = {}, token?: string) {
  const res = await fetch(`${API}/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  return (await res.json()) as { data?: any; errors?: { message: string; extensions?: { code?: string } }[] };
}
const START = `mutation($i: StartConversationInput!) { startConversation(input: $i) { id startedNow contact { id waId name } } }`;
const created = { users: [] as string[], workspaces: [] as string[] };
let owner = '';
let agent = '';
let ws = '';

before(async () => {
  const r = (await gql(`mutation($i: RegisterInput!) { register(input: $i) { token user { id } workspace { id } } }`, { i: { name: 'Start Owner', email: `e2e-start-o-${run}@example.com`, password: 'password123', workspaceName: `Start Co ${run}` } })).data.register;
  owner = r.token;
  ws = r.workspace.id;
  created.users.push(r.user.id);
  created.workspaces.push(ws);
  const email = `e2e-start-a-${run}@example.com`;
  const u = await prisma.user.create({ data: { name: 'Start Agent', email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role: 'agent', workspaceId: ws } } } });
  created.users.push(u.id);
  agent = (await gql(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } })).data.login.token;
});
after(async () => {
  const workspaceId = { in: created.workspaces };
  await prisma.contactRemark.deleteMany({ where: { contact: { workspaceId } } }).catch(() => {});
  await prisma.conversation.deleteMany({ where: { workspaceId } });
  await prisma.contact.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  await prisma.$disconnect();
});

describe('Start a new conversation', () => {
  test('real numbers only, stored as digits with the country code; invalid ones refused', async () => {
    const a = (await gql(START, { i: { waId: '+971 50 123 4567', name: 'Omar' } }, agent)).data.startConversation;
    assert.deepEqual([a.startedNow, a.contact.waId, a.contact.name], [true, '971501234567', 'Omar']);
    for (const bad of ['12345', '0000000000', '+999 123', ''])
      assert.equal((await gql(START, { i: { waId: bad } }, agent)).errors?.[0].extensions?.code, 'BAD_USER_INPUT', bad);
  });

  test('the same number again (any format) reuses the contact and chat; the saved name is kept', async () => {
    const first = (await gql(START, { i: { waId: '971501234567' } }, owner)).data.startConversation;
    const again = (await gql(START, { i: { waId: '+971-50-123-4567', name: 'Someone else' } }, agent)).data.startConversation;
    assert.equal(again.id, first.id);
    assert.equal(again.startedNow, false);
    assert.equal(again.contact.name, 'Omar');
    assert.equal(await prisma.contact.count({ where: { workspaceId: ws, waId: '971501234567' } }), 1);
  });

  test('started twice at the same moment: one contact, one chat', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => gql(START, { i: { waId: '919016312927' } }, agent)));
    assert.ok(results.every((r) => !r.errors), JSON.stringify(results.find((r) => r.errors)?.errors));
    assert.equal(new Set(results.map((r) => r.data.startConversation.id)).size, 1);
    assert.equal(await prisma.contact.count({ where: { workspaceId: ws, waId: '919016312927' } }), 1);
    assert.equal(await prisma.conversation.count({ where: { workspaceId: ws, contact: { waId: '919016312927' } } }), 1);
  });

  test('a deleted contact comes back instead of being duplicated, as a fresh start (not "already has a chat")', async () => {
    const c = await prisma.contact.findFirstOrThrow({ where: { workspaceId: ws, waId: '971501234567' } });
    await prisma.contact.update({ where: { id: c.id }, data: { deletedAt: new Date() } });
    const back = (await gql(START, { i: { waId: '971501234567' } }, owner)).data.startConversation;
    assert.equal(back.contact.id, c.id);
    assert.equal(back.startedNow, true); // revived from deletion: the team should see this as new, not a duplicate
    assert.equal((await prisma.contact.findUniqueOrThrow({ where: { id: c.id } })).deletedAt, null);
    assert.equal(await prisma.contact.count({ where: { workspaceId: ws, waId: '971501234567' } }), 1); // never a second row
  });

  test('deleting a contact (the real admin mutation) removes it for good; the same number starting again is a brand-new contact', async () => {
    const waId = '971555000111';
    const started = (await gql(START, { i: { waId, name: 'Nadia' } }, owner)).data.startConversation;
    const contactId = started.contact.id;
    const conversationId = started.id;
    await prisma.message.create({ data: { conversationId, direction: 'in', type: 'text', body: 'Hello there', status: 'received' } });

    const del = await gql(`mutation($id: ID!) { deleteContact(id: $id) }`, { id: contactId }, owner);
    assert.equal(del.errors, undefined, JSON.stringify(del.errors));
    // Hard delete: the contact, its chat and its messages are gone outright, not just hidden
    assert.equal(await prisma.contact.count({ where: { id: contactId } }), 0);
    assert.equal(await prisma.conversation.count({ where: { id: conversationId } }), 0);
    assert.equal(await prisma.message.count({ where: { conversationId } }), 0);

    // The number can be started again: a brand-new contact and chat, with no memory of the deleted one
    const again = await gql(START, { i: { waId, name: 'Nadia' } }, owner);
    assert.equal(again.errors, undefined, JSON.stringify(again.errors));
    const revived = again.data.startConversation;
    assert.notEqual(revived.contact.id, contactId); // a new row, not the deleted one coming back
    assert.notEqual(revived.id, conversationId); // a new chat, with no prior history
    assert.equal(revived.startedNow, true);
    assert.equal(await prisma.contact.count({ where: { workspaceId: ws, waId } }), 1); // exactly one row, the new one

    // Duplicate prevention for ACTIVE contacts is unaffected: a second row for the same number is still rejected
    await assert.rejects(
      prisma.contact.create({ data: { workspaceId: ws, waId, name: 'Someone else', leadStage: 'new' } }),
      /Unique constraint/i,
    );
  });

  test('a new chat appears in everyone\'s inbox live (conversation:started); reusing one sends nothing', async () => {
    const events: any[] = [];
    const socket = connectSocket(API, { auth: { token: owner }, transports: ['websocket'] });
    socket.on('conversation:started', (e) => events.push(e));
    await new Promise<void>((r, j) => {
      socket.on('connect', () => r());
      socket.on('connect_error', j);
    });
    try {
      const c = (await gql(START, { i: { waId: '447911123456' } }, agent)).data.startConversation;
      await gql(START, { i: { waId: '447911123456' } }, agent); // the same number again
      await new Promise((r) => setTimeout(r, 400));
      assert.deepEqual(events.map((e) => e.conversationId), [c.id]);
      assert.equal(events[0].contactName, '+447911123456');
    } finally {
      socket.close();
    }
  });
});

describe('message lengths: WhatsApp and database limits only', () => {
  test('automatic replies up to 4096 characters (a WhatsApp text message); internal notes up to 16,000', async () => {
    const s = (await gql(`{ automationSettings { replyMaxLength } }`, {}, owner)).data.automationSettings;
    assert.equal(s.replyMaxLength, 4096);
    const long = 'x'.repeat(1500); // over the old 500 limit
    const saved = await gql(`mutation($i: AutomationSettingsInput!) { updateAutomationSettings(input: $i) { replyInHours } }`, { i: { replyInHours: long } }, owner);
    assert.equal(saved.data?.updateAutomationSettings.replyInHours.length, 1500, JSON.stringify(saved.errors));
    assert.equal((await gql(`mutation($i: AutomationSettingsInput!) { updateAutomationSettings(input: $i) { id: enabled } }`, { i: { replyInHours: 'x'.repeat(4097) } }, owner)).errors?.[0].extensions?.code, 'BAD_USER_INPUT');
    const contact = await prisma.contact.findFirstOrThrow({ where: { workspaceId: ws } });
    const note = await gql(`mutation($c: ID!, $b: String!) { addContactRemark(contactId: $c, body: $b) { id } }`, { c: contact.id, b: 'n'.repeat(5000) }, agent);
    assert.ok(note.data?.addContactRemark.id, JSON.stringify(note.errors));
  });
});
