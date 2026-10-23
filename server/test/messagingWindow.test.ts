// WhatsApp's 24-hour customer service window. Free-form messages (text, replies, images, documents, voice notes,
// reactions) only within 24 hours of the customer's last message, for every role, through the API and the services;
// templates any time; a new customer message opens it again. The window runs from Meta's webhook timestamp, and
// "typing…" isn't relayed once it has closed. Runs in this process with WhatsApp replaced by a mock (nothing is
// sent); the API server must be running (API_URL) for the GraphQL and Socket.IO parts.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';
import bcrypt from 'bcryptjs';
import { io as connectSocket, type Socket } from 'socket.io-client';
import { WINDOW_MS, inboundSentAt, laterOf, windowOpen } from '../src/services/messagingWindow.js';

const sent: any[] = []; // what reached the (mock) WhatsApp API
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url?.endsWith('/media')) return res.end(JSON.stringify({ id: `media-${Date.now()}` }));
    if (req.url?.endsWith('/messages')) {
      sent.push(JSON.parse(body || '{}'));
      return res.end(JSON.stringify({ messages: [{ id: `wamid.out-${Date.now()}-${Math.random().toString(36).slice(2)}` }] }));
    }
    res.end('{}');
  });
});

const API = process.env.API_URL ?? 'http://localhost:5001';
const run = Date.now();
async function gql(query: string, variables: object = {}, token?: string) {
  const res = await fetch(`${API}/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  return (await res.json()) as { data?: any; errors?: { message: string; extensions?: { code?: string } }[] };
}
const HOUR = 3_600_000;

describe('the window itself', () => {
  test('open for 24 hours after the customer last wrote, then closed; never without a customer message', () => {
    const now = Date.parse('2026-10-23T12:00:00Z');
    assert.equal(windowOpen(new Date(now - 23 * HOUR), now), true);
    assert.equal(windowOpen(new Date(now - WINDOW_MS + 1000), now), true);
    assert.equal(windowOpen(new Date(now - WINDOW_MS), now), false);
    assert.equal(windowOpen(new Date(now - 30 * HOUR), now), false);
    assert.equal(windowOpen(null, now), false);
  });
  test("Meta's timestamp (Unix seconds) is when the customer sent it; missing, bad or future ones are now", () => {
    const now = new Date('2026-10-23T12:00:00Z');
    assert.equal(inboundSentAt('1792743000', now).toISOString(), new Date(1792743000 * 1000).toISOString());
    assert.equal(inboundSentAt(1792743000, now).getTime(), 1792743000 * 1000);
    for (const bad of [undefined, null, '', 'abc', '-5', '0', {}, '17927430001234'])
      assert.equal(inboundSentAt(bad, now).getTime(), now.getTime(), String(bad));
    assert.equal(inboundSentAt(String(Math.floor(now.getTime() / 1000) + 3600), now).getTime(), now.getTime()); // future
  });
  test('a late retry of an older message never moves the window back', () => {
    const a = new Date('2026-10-23T10:00:00Z');
    const b = new Date('2026-10-23T11:00:00Z');
    assert.equal(laterOf(b, a), b);
    assert.equal(laterOf(a, b), b);
    assert.equal(laterOf(null, a), a);
  });
});

let messages: typeof import('../src/messages.js');
let inbox: typeof import('../src/services/inbox.js');
let reactions: typeof import('../src/services/reactions.js');
let prisma: typeof import('../src/prisma.js')['prisma'];
const created = { users: [] as string[], workspaces: [] as string[] };
before(async () => {
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
  process.env.GRAPH_API_BASE = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
  messages = await import('../src/messages.js');
  inbox = await import('../src/services/inbox.js');
  reactions = await import('../src/services/reactions.js');
  prisma = (await import('../src/prisma.js')).prisma;
});
after(async () => {
  mock.close();
  const workspaceId = { in: created.workspaces };
  await prisma.message.deleteMany({ where: { conversation: { workspaceId } } });
  await prisma.assignmentRecord.deleteMany({ where: { workspaceId } });
  await prisma.conversation.updateMany({ where: { workspaceId }, data: { assignedToId: null } });
  await prisma.conversation.deleteMany({ where: { workspaceId } });
  await prisma.contact.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  await prisma.$disconnect();
});

describe('sending inside and outside the window', () => {
  let ws = '';
  let owner = { id: '', token: '' };
  const tokens: Record<string, string> = {};
  let conv = '';
  const waId = `9715${String(run).slice(-8)}`;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const setLastInbound = (at: Date) => prisma.conversation.update({ where: { id: conv }, data: { lastInboundAt: at } });
  const codeOf = (p: Promise<unknown>) => p.then(() => 'OK', (e) => (e as { code?: string }).code ?? (e as Error).message);

  before(async () => {
    const r = (await gql(`mutation($i: RegisterInput!) { register(input: $i) { token user { id } workspace { id } } }`, { i: { name: 'Win Owner', email: `e2e-win-o-${run}@example.com`, password: 'password123', workspaceName: `Window Co ${run}` } })).data.register;
    ws = r.workspace.id;
    owner = { id: r.user.id, token: r.token };
    created.workspaces.push(ws);
    created.users.push(owner.id);
    tokens.owner = owner.token;
    await prisma.whatsAppAccount.create({ data: { workspaceId: ws, wabaId: `waba-w-${run}`, phoneNumberId: `pn-w-${run}`, displayPhone: `+1 555 ${String(run).slice(-7)}`, accessToken: 'mock-token' } });
    for (const role of ['admin', 'supervisor', 'agent']) {
      const email = `e2e-win-${role}-${run}@example.com`;
      const u = await prisma.user.create({ data: { name: `Win ${role}`, email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role, workspaceId: ws } } } });
      created.users.push(u.id);
      tokens[role] = (await gql(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } })).data.login.token;
    }
    // The customer wrote 30 hours ago (Meta's timestamp), the webhook arriving now
    const old = Math.floor((Date.now() - 30 * HOUR) / 1000);
    const parsed = messages.parseWebhookMessage({ from: waId, id: `wamid.w-${run}-1`, timestamp: String(old), type: 'text', text: { body: 'Any 18 inch tyres?' } }, [{ wa_id: waId, profile: { name: 'Window Cust' } }]);
    await messages.saveIncoming(ws, parsed);
    conv = (await prisma.conversation.findFirstOrThrow({ where: { workspaceId: ws, contact: { waId } } })).id;
    // the chat is held by the agent, so every role may write in it (apart from the window)
    const agentMember = await prisma.member.findFirstOrThrow({ where: { workspaceId: ws, role: 'agent' } });
    await prisma.conversation.update({ where: { id: conv }, data: { assignedToId: agentMember.id } });
  });

  test("lastInboundAt is Meta's timestamp of the customer's message, not when the webhook arrived", async () => {
    const c = await prisma.conversation.findUniqueOrThrow({ where: { id: conv } });
    assert.ok(Math.abs(c.lastInboundAt!.getTime() - (Date.now() - 30 * HOUR)) < 5000, c.lastInboundAt!.toISOString());
  });

  test('closed: every role is refused free text through the API (owner, admin, supervisor, agent)', async () => {
    for (const role of ['owner', 'admin', 'supervisor', 'agent']) {
      const r = await gql(`mutation($i: SendTextInput!) { sendTextMessage(input: $i) { id } }`, { i: { conversationId: conv, body: 'hi' } }, tokens[role]);
      assert.equal(r.errors?.[0].extensions?.code, 'WINDOW_CLOSED', `${role}: ${JSON.stringify(r.errors)}`);
    }
  });

  test('closed: text, reply, image, document and reaction are refused by the services too (voice notes take the same media path); nothing reaches WhatsApp', async () => {
    const before = sent.length;
    const question = await prisma.message.findFirstOrThrow({ where: { conversationId: conv, direction: 'in' } });
    assert.equal(await codeOf(inbox.sendMessage(ws, conv, { type: 'text', body: 'hello' }, owner.id)), 'WINDOW_CLOSED');
    assert.equal(await codeOf(inbox.sendMessage(ws, conv, { type: 'text', body: 'hello', replyToId: question.id }, owner.id)), 'WINDOW_CLOSED');
    assert.equal(await codeOf(inbox.sendMediaMessage('image', ws, conv, png, 'image/png', '', null, owner.id)), 'WINDOW_CLOSED');
    assert.equal(await codeOf(inbox.sendMediaMessage('document', ws, conv, Buffer.from('%PDF-1.4 x'), 'application/pdf', '', 'a.pdf', owner.id)), 'WINDOW_CLOSED');
    assert.equal(await codeOf(reactions.reactToMessage({ userId: owner.id, workspaceId: ws }, question.id, '👍')), 'WINDOW_CLOSED');
    assert.equal(sent.length, before);
  });

  test('closed: templates are still allowed (the window check lets them through)', async () => {
    // The mock lists no approved templates, so it fails later, on the template itself, never on the window
    const templates = await import('../src/services/templates.js');
    const code = await codeOf(templates.sendTemplateMessage({ userId: owner.id, workspaceId: ws }, { conversationId: conv, name: 'hello_world', confirmed: true, requestId: `win-${run}` }));
    assert.notEqual(code, 'WINDOW_CLOSED');
  });

  test('a new customer message opens it again; a late retry of an older message does not close it', async () => {
    await messages.saveIncoming(ws, messages.parseWebhookMessage({ from: waId, id: `wamid.w-${run}-2`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hello?' } }));
    const reply = await inbox.sendMessage(ws, conv, { type: 'text', body: 'Yes, in stock' }, owner.id);
    assert.equal(reply.status, 'sent');
    assert.equal(sent.at(-1).text.body, 'Yes, in stock');
    const openAt = (await prisma.conversation.findUniqueOrThrow({ where: { id: conv } })).lastInboundAt!;
    await messages.saveIncoming(ws, messages.parseWebhookMessage({ from: waId, id: `wamid.w-${run}-3`, timestamp: String(Math.floor((Date.now() - 40 * HOUR) / 1000)), type: 'text', text: { body: 'old one' } }));
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: conv } })).lastInboundAt!.getTime(), openAt.getTime());
    // every role may write again
    const r = await gql(`mutation($i: SendTextInput!) { sendTextMessage(input: $i) { id } }`, { i: { conversationId: conv, body: 'x' } }, tokens.agent);
    assert.notEqual(r.errors?.[0].extensions?.code, 'WINDOW_CLOSED');
  });

  test('just over 24 hours: closed again', async () => {
    await setLastInbound(new Date(Date.now() - WINDOW_MS - 1000));
    assert.equal(await codeOf(inbox.sendMessage(ws, conv, { type: 'text', body: 'late' }, owner.id)), 'WINDOW_CLOSED');
    await setLastInbound(new Date(Date.now() - WINDOW_MS + 60_000));
    assert.equal(await codeOf(inbox.sendMessage(ws, conv, { type: 'text', body: 'just in time' }, owner.id)), 'OK');
  });

  test('Socket.IO: "typing…" reaches the team inside the window, and is dropped once it has closed', async () => {
    const connect = (token: string) =>
      new Promise<{ socket: Socket; typing: any[] }>((resolve, reject) => {
        const socket = connectSocket(API, { auth: { token }, transports: ['websocket'] });
        const typing: any[] = [];
        socket.on('typing', (e) => typing.push(e));
        socket.on('connect', () => resolve({ socket, typing }));
        socket.on('connect_error', reject);
      });
    const settle = () => new Promise((r) => setTimeout(r, 400));
    const a = await connect(tokens.agent);
    const b = await connect(tokens.owner);
    try {
      await setLastInbound(new Date(Date.now() - HOUR));
      a.socket.emit('typing', { conversationId: conv, typing: true });
      await settle();
      assert.deepEqual(b.typing.map((e) => [e.conversationId, e.typing]), [[conv, true]]);
      a.socket.emit('typing', { conversationId: conv, typing: false });
      await settle();
      b.typing.length = 0;
      await setLastInbound(new Date(Date.now() - 25 * HOUR));
      a.socket.emit('typing', { conversationId: conv, typing: true });
      await settle();
      assert.deepEqual(b.typing, []); // closed: not relayed
    } finally {
      a.socket.close();
      b.socket.close();
    }
  });
});
