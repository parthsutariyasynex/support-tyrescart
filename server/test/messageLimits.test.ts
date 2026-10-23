// Text length limits are WhatsApp's own (4096 per text message, 1024 per caption) and the database's (16,000 for
// a remark): text at the limit goes through whole, text over it is refused before anything is stored or sent (never
// cut), and activity previews that are shortened say so with "…". Runs with WhatsApp replaced by a mock (nothing is
// sent); the API server must be running (API_URL) for sign-ups.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';

const sent: any[] = [];
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url?.endsWith('/messages')) {
      sent.push(JSON.parse(body || '{}'));
      return res.end(JSON.stringify({ messages: [{ id: `wamid.lim-${Date.now()}-${Math.random().toString(36).slice(2)}` }] }));
    }
    res.end('{}');
  });
});
const API = process.env.API_URL ?? 'http://localhost:5001';
const run = Date.now();
const gql = async (query: string, variables: object = {}, token?: string) =>
  (await (await fetch(`${API}/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) })).json()) as any;

let messages: typeof import('../src/messages.js');
let inbox: typeof import('../src/services/inbox.js');
let actions: typeof import('../src/services/messageActions.js');
let activity: typeof import('../src/services/activity.js');
let prisma: typeof import('../src/prisma.js')['prisma'];
const created = { users: [] as string[], workspaces: [] as string[] };
before(async () => {
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
  process.env.GRAPH_API_BASE = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
  messages = await import('../src/messages.js');
  inbox = await import('../src/services/inbox.js');
  actions = await import('../src/services/messageActions.js');
  activity = await import('../src/services/activity.js');
  prisma = (await import('../src/prisma.js')).prisma;
});
after(async () => {
  mock.close();
  const workspaceId = { in: created.workspaces };
  await prisma.messageRevision.deleteMany({ where: { message: { conversation: { workspaceId } } } });
  await prisma.message.deleteMany({ where: { conversation: { workspaceId } } });
  await prisma.conversation.deleteMany({ where: { workspaceId } });
  await prisma.contact.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  await prisma.$disconnect();
});

test('a shortened preview ends with "…"; a short one is unchanged', () => {
  assert.equal(activity.previewOf('Hello', 200), 'Hello');
  const p = activity.previewOf('x'.repeat(300), 200);
  assert.equal(p.length, 200);
  assert.ok(p.endsWith('…'));
  // never half an emoji
  const e = activity.previewOf('🚗'.repeat(150), 100);
  assert.equal(Array.from(e).length, 100);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(e), 'no lone surrogate');
});

describe("chat messages: WhatsApp's limit, never cut", () => {
  test('4096 characters (emoji too) are sent and stored whole; 4097 are refused before anything is stored or sent', async () => {
    const r = (await gql(`mutation($i: RegisterInput!) { register(input: $i) { token user { id } workspace { id } } }`, { i: { name: 'Lim Owner', email: `e2e-lim-${run}@example.com`, password: 'password123', workspaceName: `Limits ${run}` } })).data.register;
    const ws = r.workspace.id;
    created.workspaces.push(ws);
    created.users.push(r.user.id);
    await prisma.whatsAppAccount.create({ data: { workspaceId: ws, wabaId: `waba-l-${run}`, phoneNumberId: `pn-l-${run}`, accessToken: 'mock-token' } });
    const waId = `9715${String(run).slice(-8)}`;
    // the customer writes a very long message: stored whole
    const longIn = '🚗'.repeat(2048); // 4096 UTF-16 units, 8 KB in the database
    await messages.saveIncoming(ws, { waId, name: 'Long Writer', type: 'text', body: longIn, waMessageId: `wamid.lim-in-${run}` });
    const conv = await prisma.conversation.findFirstOrThrow({ where: { workspaceId: ws } });
    assert.equal((await prisma.message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'in' } })).body, longIn);
    // and its activity entry was recorded (a preview cut inside an emoji used to be refused by the database)
    const act = await prisma.activityEvent.findFirst({ where: { conversationId: conv.id, type: 'message_received' } });
    assert.ok(act, 'activity recorded');
    assert.ok(String((act!.data as { preview?: string }).preview).endsWith('…'));

    const atLimit = 'a'.repeat(4096);
    const ok = await inbox.sendMessage(ws, conv.id, { type: 'text', body: atLimit }, r.user.id);
    assert.equal(ok.body.length, 4096);
    assert.equal(sent.at(-1).text.body, atLimit);
    const before = { sent: sent.length, stored: await prisma.message.count({ where: { conversationId: conv.id } }) };
    await assert.rejects(inbox.sendMessage(ws, conv.id, { type: 'text', body: 'a'.repeat(4097) }, r.user.id), (e: any) => e.code === 'BAD_USER_INPUT');
    assert.equal(sent.length, before.sent);
    assert.equal(await prisma.message.count({ where: { conversationId: conv.id } }), before.stored);

    // editing: up to 4096 kept whole, over it refused and the message unchanged
    const auth = { userId: r.user.id, workspaceId: ws };
    const edited = await actions.editMessage(auth, ok.id, { body: 'b'.repeat(4096), version: ok.version });
    assert.equal(edited.body.length, 4096);
    await assert.rejects(actions.editMessage(auth, ok.id, { body: 'c'.repeat(4097), version: edited.version }), (e: any) => e.code === 'BAD_USER_INPUT');
    assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: ok.id } })).body, 'b'.repeat(4096));
  });
});
