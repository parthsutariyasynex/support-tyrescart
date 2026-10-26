// "Delete chat" (like WhatsApp): only for the person who deletes it. The chat leaves their list, also after a
// refresh (a new request or a new sign-in), until a newer message brings it back. Nothing is removed from the
// database, and teammates keep the chat as it was. The API server must be running (API_URL).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import bcrypt from 'bcryptjs';
import { io as connectSocket } from 'socket.io-client';
import { prisma } from '../src/prisma.js';

const API = process.env.API_URL ?? 'http://localhost:5001';
const run = Date.now();
const gql = async (query: string, variables: object = {}, token?: string) =>
  (await (await fetch(`${API}/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) })).json()) as any;
const ok = async (query: string, variables: object = {}, token?: string) => {
  const r = await gql(query, variables, token);
  assert.equal(r.errors, undefined, JSON.stringify(r.errors));
  return r.data;
};
const code = async (query: string, variables: object = {}, token?: string) => (await gql(query, variables, token)).errors?.[0]?.extensions?.code;

const DELETE = `mutation($id: ID!) { deleteConversationForMe(id: $id) }`;
const LIST = `{ conversations(first: 50) { nodes { id pinned lastMessage { body } } } }`;
const MSGS = `query($id: ID!) { messages(conversationId: $id) { nodes { body } } }`;
const SIMULATE = `mutation($i: SimulateIncomingInput) { simulateIncomingMessage(input: $i) }`;
const created = { users: [] as string[], workspaces: [] as string[] };
const people: Record<string, { id: string; token: string; email: string }> = {};
let ws = '';
let otherWs = '';
let otherToken = '';
const chat: Record<string, string> = {};
// Valid UAE mobile numbers (971 50 + 7 digits), different every run
const number = (n: number) => `97150${String(run + n).slice(-7)}`;

const login = async (email: string) => (await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } })).login.token as string;
const listIds = async (token: string) => (await ok(LIST, {}, token)).conversations.nodes.map((c: any) => c.id) as string[];
const pause = () => new Promise((r) => setTimeout(r, 30));

before(async () => {
  const email = `e2e-del-o-${run}@example.com`;
  const r = (await gql(`mutation($i: RegisterInput!) { register(input: $i) { token user { id } workspace { id } } }`, { i: { name: 'Del Owner', email, password: 'password123', workspaceName: `Delete chat ${run}` } })).data.register;
  ws = r.workspace.id;
  people.owner = { id: r.user.id, token: r.token, email };
  created.workspaces.push(ws);
  created.users.push(r.user.id);
  for (const role of ['agent', 'admin']) {
    const e = `e2e-del-${role}-${run}@example.com`;
    const u = await prisma.user.create({ data: { name: `Del ${role}`, email: e, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role, workspaceId: ws } } } });
    created.users.push(u.id);
    people[role] = { id: u.id, token: await login(e), email: e };
  }
  const o = (await gql(`mutation($i: RegisterInput!) { register(input: $i) { token user { id } workspace { id } } }`, { i: { name: 'Del Other', email: `e2e-del-x-${run}@example.com`, password: 'password123', workspaceName: `Delete other ${run}` } })).data.register;
  otherWs = o.workspace.id;
  otherToken = o.token;
  created.workspaces.push(otherWs);
  created.users.push(o.user.id);
  for (const [i, name] of ['Asha', 'Bilal', 'Chen'].entries()) {
    await ok(SIMULATE, { i: { waId: number(i), name, body: `Hello from ${name}` } }, people.owner.token);
    chat[name] = (await prisma.conversation.findFirstOrThrow({ where: { workspaceId: ws, contact: { name } } })).id;
  }
  // An attachment in Asha's chat, to check it is kept
  await prisma.message.create({ data: { conversationId: chat.Asha, direction: 'in', type: 'image', body: '', mediaPath: `${ws}/photo-${run}.jpg`, mediaMime: 'image/jpeg', mediaSize: 1234 } });
});
after(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: created.workspaces } } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  await prisma.$disconnect();
});

describe('delete chat', () => {
  test('rejected without signing in, for unknown chats and for other workspaces; nothing changes', async () => {
    assert.equal(await code(DELETE, { id: chat.Asha }), 'UNAUTHENTICATED');
    assert.equal(await code(DELETE, { id: 'nope' }, people.owner.token), 'NOT_FOUND');
    assert.equal(await code(DELETE, { id: chat.Asha }, otherToken), 'NOT_FOUND');
    assert.equal(await prisma.activityEvent.count({ where: { workspaceId: { in: [ws, otherWs] }, type: 'chat_deleted' } }), 0);
    for (const p of Object.values(people)) assert.ok((await listIds(p.token)).includes(chat.Asha));
  });

  test('confirmed delete: the chat leaves only that person\'s list, also after a refresh and a new sign-in', async () => {
    await ok(`mutation($id: ID!) { pinConversation(id: $id) { id } }`, { id: chat.Asha }, people.agent.token);
    const sock = await new Promise<{ close: () => void; events: any[] }>((resolve, reject) => {
      const events: any[] = [];
      const s = connectSocket(API, { auth: { token: people.agent.token }, transports: ['websocket'] });
      s.on('conversation:deleted', (e) => events.push(e));
      s.on('connect', () => resolve({ close: () => s.close(), events }));
      s.on('connect_error', reject);
    });
    const ownerSock = await new Promise<{ close: () => void; events: any[] }>((resolve, reject) => {
      const events: any[] = [];
      const s = connectSocket(API, { auth: { token: people.owner.token }, transports: ['websocket'] });
      s.on('conversation:deleted', (e) => events.push(e));
      s.on('connect', () => resolve({ close: () => s.close(), events }));
      s.on('connect_error', reject);
    });
    try {
      assert.equal((await ok(DELETE, { id: chat.Asha }, people.agent.token)).deleteConversationForMe, true);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(sock.events.length, 1, 'their other tabs drop it');
      assert.equal(sock.events[0].conversationId, chat.Asha);
      assert.equal(ownerSock.events.length, 0, 'nobody else is told');
    } finally {
      sock.close();
      ownerSock.close();
    }
    // Refresh: the list is asked for again, and again after signing in afresh
    assert.ok(!(await listIds(people.agent.token)).includes(chat.Asha));
    assert.ok(!(await listIds(await login(people.agent.email))).includes(chat.Asha));
    assert.deepEqual((await listIds(people.agent.token)).sort(), [chat.Bilal, chat.Chen].sort());
    // Also not found by searching, and no longer pinned
    assert.ok(!(await ok(`{ conversations(first: 50, search: "Asha") { nodes { id } } }`, {}, people.agent.token)).conversations.nodes.some((c: any) => c.id === chat.Asha));
    assert.equal(await prisma.conversationPin.count({ where: { userId: people.agent.id, conversationId: chat.Asha } }), 0);
    // Teammates (whatever their role) still have it, with its messages
    for (const p of [people.owner, people.admin]) {
      assert.ok((await listIds(p.token)).includes(chat.Asha));
      assert.equal((await ok(MSGS, { id: chat.Asha }, p.token)).messages.nodes.length, 2);
    }
  });

  test('everything stays in the database: the chat, its messages, the attachment, its history and the log', async () => {
    const conversation = await prisma.conversation.findUnique({ where: { id: chat.Asha } });
    assert.ok(conversation);
    assert.equal(conversation.deletedAt, null, 'not soft-deleted for everyone');
    const messages = await prisma.message.findMany({ where: { conversationId: chat.Asha } });
    assert.equal(messages.length, 2);
    assert.ok(messages.every((m) => m.deletedAt === null));
    assert.ok(messages.some((m) => m.mediaPath === `${ws}/photo-${run}.jpg` && m.mediaSize === 1234));
    assert.ok(await prisma.contact.findFirst({ where: { workspaceId: ws, name: 'Asha', deletedAt: null } }));
    // The personal marker and the clear row are the agent's own
    const marker = await prisma.activityEvent.findMany({ where: { conversationId: chat.Asha, type: 'chat_deleted' } });
    assert.deepEqual(marker.map((m) => m.actorId), [people.agent.id]);
    assert.ok(await prisma.conversationClear.findUnique({ where: { userId_conversationId: { userId: people.agent.id, conversationId: chat.Asha } } }));
    assert.equal(await prisma.conversationClear.count({ where: { conversationId: chat.Asha, userId: { not: people.agent.id } } }), 0);
    // Logged (the API server writes log rows to the same database)
    await new Promise((r) => setTimeout(r, 200));
    const logged = await prisma.logEntry.findFirst({ where: { workspaceId: ws, event: 'conversation.deleted_for_user', userId: people.agent.id } });
    assert.ok(logged, 'the delete is in the log');
  });

  test('the delete never shows up in anyone\'s timeline, bell or contact activity', async () => {
    const TIMELINE = `query($c: ID!) { conversationActivity(conversationId: $c) { type } }`;
    for (const p of Object.values(people)) {
      assert.ok(!(await ok(TIMELINE, { c: chat.Asha }, p.token)).conversationActivity.some((a: any) => a.type === 'chat_deleted'));
      assert.ok(!(await ok(`{ notifications { items { type } } }`, {}, p.token)).notifications.items.some((a: any) => a.type === 'chat_deleted'));
    }
  });

  test('a new message brings the chat back, empty up to the delete (history stays hidden for that person)', async () => {
    await pause();
    await ok(SIMULATE, { i: { waId: number(0), body: 'Are you there?' } }, people.owner.token);
    const back = (await ok(LIST, {}, people.agent.token)).conversations.nodes.find((c: any) => c.id === chat.Asha);
    assert.ok(back, 'back in the list');
    assert.equal(back.pinned, false);
    assert.equal(back.lastMessage.body, 'Are you there?');
    assert.deepEqual((await ok(MSGS, { id: chat.Asha }, people.agent.token)).messages.nodes.map((m: any) => m.body), ['Are you there?']);
    assert.equal((await ok(MSGS, { id: chat.Asha }, people.owner.token)).messages.nodes.length, 3);
    // Deleting again works the same way
    await pause();
    await ok(DELETE, { id: chat.Asha }, people.agent.token);
    assert.ok(!(await listIds(people.agent.token)).includes(chat.Asha));
    assert.equal(await prisma.message.count({ where: { conversationId: chat.Asha } }), 3);
  });

  test('any role can delete a chat for themselves without affecting the others', async () => {
    await ok(DELETE, { id: chat.Bilal }, people.owner.token);
    assert.ok(!(await listIds(people.owner.token)).includes(chat.Bilal));
    assert.ok((await listIds(people.agent.token)).includes(chat.Bilal));
    assert.ok((await listIds(people.admin.token)).includes(chat.Bilal));
  });
});
