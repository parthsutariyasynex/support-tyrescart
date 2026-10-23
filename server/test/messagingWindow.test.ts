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
    // Approved templates of the (mock) number: one plain template
    if (req.url?.includes('/message_templates'))
      return res.end(JSON.stringify({ data: [{ id: 't-open', name: 'shop_open', language: 'en_US', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'We are open: reply to this message any time.' }] }] }));
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

describe('fixes: auto-reply, Meta notices, templates after 24 hours', () => {
  let ws = '';
  let owner = { id: '', token: '' };
  const phoneNumberId = `pn-fix-${run}`;
  before(async () => {
    const r = (await gql(`mutation($i: RegisterInput!) { register(input: $i) { token user { id } workspace { id } } }`, { i: { name: 'Fix Owner', email: `e2e-winfix-${run}@example.com`, password: 'password123', workspaceName: `Window Fix ${run}` } })).data.register;
    ws = r.workspace.id;
    owner = { id: r.user.id, token: r.token };
    created.workspaces.push(ws);
    created.users.push(owner.id);
    await prisma.whatsAppAccount.create({ data: { workspaceId: ws, wabaId: `waba-fix-${run}`, phoneNumberId, accessToken: 'mock-token' } });
    // Auto-reply on, all day every day
    await prisma.automationSettings.create({ data: { workspaceId: ws, enabled: true, replyInHoursEnabled: true, replyInHours: 'Thanks, we reply soon', replyOutHoursEnabled: true, replyOutHours: 'Thanks, we reply soon', workingDays: '0,1,2,3,4,5,6', workStart: '00:00', workEnd: '23:59', createdBy: owner.id } });
  });
  after(async () => {
    await prisma.automationSettings.deleteMany({ where: { workspaceId: ws } });
  });
  const autoReplies = (waId: string) => prisma.message.count({ where: { automation: 'auto_reply', conversation: { workspaceId: ws, contact: { waId } } } });
  const settle = () => new Promise((r) => setTimeout(r, 700));

  test('auto-reply only inside the window: a message Meta delivers 30 hours late gets none; a fresh one does', async () => {
    const lateWa = `97155${String(run).slice(-7)}`;
    const before = sent.length;
    await messages.saveIncoming(ws, messages.parseWebhookMessage({ from: lateWa, id: `wamid.fix-late-${run}`, timestamp: String(Math.floor((Date.now() - 30 * HOUR) / 1000)), type: 'text', text: { body: 'old' } }));
    await settle();
    assert.equal(await autoReplies(lateWa), 0);
    assert.equal(sent.length, before, 'nothing sent to WhatsApp');
    const freshWa = `97156${String(run).slice(-7)}`;
    await messages.saveIncoming(ws, messages.parseWebhookMessage({ from: freshWa, id: `wamid.fix-fresh-${run}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hi' } }));
    await settle();
    assert.equal(await autoReplies(freshWa), 1);
  });

  test("Meta's own notices (system, request_welcome) aren't customer messages: no chat, no window, no auto-reply", async () => {
    assert.equal(messages.isCustomerMessage({ type: 'system' }), false);
    assert.equal(messages.isCustomerMessage({ type: 'request_welcome' }), false);
    for (const type of ['text', 'image', 'unsupported', 'button', 'interactive']) assert.equal(messages.isCustomerMessage({ type }), true, type);
    // through the real webhook (the API server): a notice and a real message in one delivery
    const noticeWa = `97157${String(run).slice(-7)}`;
    const realWa = `97158${String(run).slice(-7)}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await fetch(`${API}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId }, messages: [
          { from: noticeWa, id: `wamid.fix-sys-${run}`, timestamp: ts, type: 'system', system: { body: 'User changed number', type: 'customer_changed_number' } },
          { from: noticeWa, id: `wamid.fix-welcome-${run}`, timestamp: ts, type: 'request_welcome' },
          { from: realWa, id: `wamid.fix-real-${run}`, timestamp: ts, type: 'text', text: { body: 'Do you fit tyres today?' } },
        ] } }] }],
      }),
    });
    assert.equal(res.status, 200);
    for (let i = 0; i < 20 && !(await prisma.message.count({ where: { waMessageId: `wamid.fix-real-${run}` } })); i++) await new Promise((r) => setTimeout(r, 150));
    assert.equal(await prisma.message.count({ where: { waMessageId: `wamid.fix-real-${run}` } }), 1, 'the real message is saved');
    assert.equal(await prisma.message.count({ where: { waMessageId: { in: [`wamid.fix-sys-${run}`, `wamid.fix-welcome-${run}`] } } }), 0, 'notices are not chat messages');
    assert.equal(await prisma.conversation.count({ where: { workspaceId: ws, contact: { waId: noticeWa } } }), 0, 'no chat, no window, no unread');
  });

  test('after 24 hours an approved template is sent for real (WhatsApp gets it), and it does not reopen the window', async () => {
    const waId = `97150${String(run).slice(-7)}`;
    await messages.saveIncoming(ws, messages.parseWebhookMessage({ from: waId, id: `wamid.fix-t-${run}`, timestamp: String(Math.floor((Date.now() - 26 * HOUR) / 1000)), type: 'text', text: { body: 'hello' } }));
    const conv = await prisma.conversation.findFirstOrThrow({ where: { workspaceId: ws, contact: { waId } } });
    const codeOf = (p: Promise<unknown>) => p.then(() => 'OK', (e) => (e as { code?: string }).code ?? (e as Error).message);
    assert.equal(await codeOf(inbox.sendMessage(ws, conv.id, { type: 'text', body: 'hi' }, owner.id)), 'WINDOW_CLOSED');
    const templates = await import('../src/services/templates.js');
    const before = sent.length;
    const m = await templates.sendTemplateMessage({ userId: owner.id, workspaceId: ws }, { conversationId: conv.id, name: 'shop_open', confirmed: true, requestId: `fix-tpl-${run}` });
    assert.equal(m.status, 'sent');
    assert.equal(sent.length, before + 1);
    assert.deepEqual([sent.at(-1).type, sent.at(-1).template.name], ['template', 'shop_open']);
    const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    assert.equal(windowOpen(after.lastInboundAt), false, 'only the customer writing reopens it');
    assert.equal(await codeOf(inbox.sendMessage(ws, conv.id, { type: 'text', body: 'still closed' }, owner.id)), 'WINDOW_CLOSED');
  });
});
