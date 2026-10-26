// End-to-end traceability of the logs, checked in the actual log files (JSON lines, logs/YYYY-MM-DD.log):
// a message sent, delivered and read can be followed by its WhatsApp id; received, duplicate, unmatched and late
// statuses are all recorded; database errors are logged (and still thrown); and the running API writes its HTTP
// requests and Socket.IO connections to its own file. WhatsApp is a mock; the API server must be running (API_URL)
// with the same LOG_DIR as this test (both default to server/logs).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

let failNext = false;
const graph = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (failNext) {
      failNext = false;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Re-engagement message', code: 131047, error_subcode: 2494010, fbtrace_id: 'TrAcE1', error_data: { details: 'More than 24 hours have passed since the customer last replied.' } } }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages: [{ id: `wamid.trace-${Date.now()}-${Math.random().toString(36).slice(2)}` }] }));
  });
});

const API = process.env.API_URL ?? 'http://localhost:5001';
const run = Date.now();
async function gql(query: string, variables: object = {}, token?: string) {
  const res = await fetch(`${API}/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  const j = (await res.json()) as { data?: any; errors?: { message: string }[] };
  if (j.errors) throw new Error(j.errors[0].message);
  return j.data;
}

let logFile: typeof import('../src/services/logFile.js');
let messages: typeof import('../src/messages.js');
let inbox: typeof import('../src/services/inbox.js');
let prisma: typeof import('../src/prisma.js')['prisma'];
let env: typeof import('../src/env.js')['env'];
let dir = '';
const workspaces: string[] = [];

type Line = Record<string, any>;
async function lines(where = dir): Promise<Line[]> {
  await logFile.flushLogFile();
  const text = await readFile(path.join(where, `${logFile.localDay()}.log`), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

before(async () => {
  await new Promise<void>((r) => graph.listen(0, '127.0.0.1', r));
  process.env.GRAPH_API_BASE = `http://127.0.0.1:${(graph.address() as AddressInfo).port}`; // read when env.ts loads
  env = (await import('../src/env.js')).env;
  logFile = await import('../src/services/logFile.js');
  messages = await import('../src/messages.js');
  inbox = await import('../src/services/inbox.js');
  prisma = (await import('../src/prisma.js')).prisma;
  dir = await mkdtemp(path.join(tmpdir(), 'support-trace-'));
  logFile.setLogFileDir(dir); // this process's entries: a file of their own
});
after(async () => {
  logFile.setLogFileDir();
  graph.close();
  if (workspaces.length) await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
  await prisma.$disconnect();
  await rm(dir, { recursive: true, force: true });
});

describe('a message, followed through the logs', () => {
  let ws = '';
  let owner: { userId: string; workspaceId: string };
  let conversationId = '';
  const waId = '971505557777';

  before(async () => {
    const reg = (await gql(`mutation($i: RegisterInput!) { register(input: $i) { token user { id } workspace { id } } }`, { i: { name: 'Trace Owner', email: `e2e-trace-${run}@example.com`, password: 'password123', workspaceName: `Trace ${run}` } })).register;
    ws = reg.workspace.id;
    workspaces.push(ws);
    owner = { userId: reg.user.id, workspaceId: ws };
    await prisma.whatsAppAccount.create({ data: { workspaceId: ws, wabaId: `waba-trace-${run}`, phoneNumberId: `pn-trace-${run}`, displayPhone: '+1 555 000 7070', accessToken: 'mock-token' } });
  });

  test('received (in): one entry with our id, WhatsApp’s id, the chat and "received"; a resend is recorded as duplicate', async () => {
    const at = String(Math.floor(Date.now() / 1000));
    const incoming = { from: waId, id: `wamid.in-trace-${run}`, timestamp: at, type: 'text', text: { body: 'secret customer text' } };
    const saved = await messages.saveIncoming(ws, messages.parseWebhookMessage(incoming));
    conversationId = saved!.conversationId;
    assert.equal(await messages.saveIncoming(ws, messages.parseWebhookMessage(incoming)), null);
    const all = await lines();
    const received = all.find((l) => l.event === 'message.received' && l.waMessageId === incoming.id)!;
    assert.deepEqual([received.direction, received.previousStatus, received.newStatus, received.outcome, received.messageId, received.conversationId, received.workspaceId], ['in', null, 'received', 'saved', saved!.id, conversationId, ws]);
    // Why and where: a new customer's first message, saved by messages.ts
    assert.equal(received.action, 'Save an incoming WhatsApp message');
    assert.equal(received.reason, "Meta's webhook delivered a message from a new customer (a new chat was created)");
    assert.match(received.source, /^src\/messages\.ts:\d+ saveIncoming$/);
    const dup = all.find((l) => l.event === 'message.duplicate' && l.waMessageId === incoming.id)!;
    assert.deepEqual([dup.direction, dup.outcome, dup.messageId], ['in', 'duplicate', saved!.id]);
    assert.match(dup.reason, /already saved/);
    assert.doesNotMatch(JSON.stringify(all), /secret customer text|971505557777/, "never the customer's text or number");
  });

  test('sent (out) → delivered → read: every step found by the same WhatsApp id, with Meta’s answer and the time it took', async () => {
    const m = await inbox.sendMessage(ws, conversationId, { type: 'text', body: 'Your tyres are ready' }, owner.userId);
    const wamid = m.waMessageId!;
    await messages.applyStatus(ws, { id: wamid, status: 'delivered', timestamp: '1793000000' });
    await messages.applyStatus(ws, { id: wamid, status: 'read', timestamp: '1793000005' });
    await messages.applyStatus(ws, { id: wamid, status: 'delivered', timestamp: '1793000001' }); // late, out of order
    const trail = (await lines()).filter((l) => l.waMessageId === wamid);
    // Each step: what it was, and the status before → after
    const steps = trail.map((l) => `${l.event} ${l.outcome} ${l.previousStatus ?? '-'}→${l.newStatus ?? '-'}`);
    for (const step of ['whatsapp.send accepted -→-', 'message.sent sent pending→sent', 'message.status updated sent→delivered', 'message.status updated delivered→read', 'message.status_stale skipped read→read'])
      assert.ok(steps.includes(step), `${step} in ${steps.join(' | ')}`);
    // Every step says what was done, why, and where in the code
    for (const l of trail) {
      assert.ok(l.action && l.reason && l.reason !== 'Not described', `${l.event} explains itself`);
      assert.match(l.source, /^src\/[\w/]+\.ts:\d+/, `${l.event} has its source`);
    }
    assert.equal(trail.find((l) => l.event === 'message.sent')!.reason, 'A teammate sent a message from the chat');
    assert.equal(trail.find((l) => l.event === 'message.status_stale')!.reason, 'Meta reported "delivered" after the message was already "read" (statuses arrive out of order; a status never goes back)');
    const call = trail.find((l) => l.event === 'whatsapp.send')!;
    assert.deepEqual([call.direction, call.response?.ok, call.response?.waMessageId, typeof call.durationMs], ['out', true, wamid, 'number']);
    const sent = trail.find((l) => l.event === 'message.sent')!;
    assert.deepEqual([sent.direction, sent.messageId, sent.conversationId], ['out', m.id, conversationId]);
    const read = trail.find((l) => l.event === 'message.status' && l.newStatus === 'read')!;
    assert.deepEqual([read.messageId, read.data.from, read.data.to, read.data.metaTimestamp], [m.id, 'delivered', 'read', 1793000005]);
    // The team was told (Socket.IO), with the same message id and never the text
    const emits = (await lines()).filter((l) => l.event === 'socket.emit' && l.messageId === m.id);
    assert.ok(emits.some((l) => l.data.socketEvent === 'message:new') && emits.some((l) => l.data.socketEvent === 'message:status'));
    assert.doesNotMatch(JSON.stringify(emits), /Your tyres are ready/);
  });

  test('failed: Meta’s HTTP status, code, subcode, trace id and explanation are all in the entry', async () => {
    failNext = true;
    const m = await inbox.sendMessage(ws, conversationId, { type: 'text', body: 'Hello again' }, owner.userId);
    assert.equal(m.status, 'failed');
    const all = await lines();
    const call = all.find((l) => l.event === 'whatsapp.send' && l.outcome === 'refused' && l.response?.fbtraceId === 'TrAcE1')!;
    assert.equal(call.reason, 'Deliver a text message to the customer through Meta; Meta answered HTTP 400');
    assert.deepEqual([call.direction, call.errorCode, call.response.httpStatus, call.response.subcode], ['out', 131047, 400, 2494010]);
    assert.equal(call.errorDetails, 'Re-engagement message: More than 24 hours have passed since the customer last replied.');
    const failed = all.find((l) => l.event === 'message.send_failed' && l.messageId === m.id)!;
    assert.deepEqual([failed.level, failed.outcome, failed.previousStatus, failed.newStatus, failed.errorCode, failed.conversationId], ['ERROR', 'failed', 'pending', 'failed', 131047, conversationId]);
  });

  test('a status for a message the app doesn’t know is recorded (WARNING), not dropped', async () => {
    await messages.applyStatus(ws, { id: `wamid.unknown-${run}`, status: 'delivered', timestamp: '1793000009' });
    const l = (await lines()).find((x) => x.event === 'message.status_unmatched' && x.waMessageId === `wamid.unknown-${run}`)!;
    assert.deepEqual([l.level, l.direction, l.outcome, l.newStatus], ['WARNING', 'out', 'ignored', 'delivered']);
    assert.match(l.reason, /isn't in this app/);
  });
});

describe('database errors', () => {
  test('a refused query is logged (model, operation, Prisma code) and still thrown to the caller', async () => {
    const email = `e2e-dbdup-${run}@example.com`;
    await prisma.user.create({ data: { name: 'Dup', email, passwordHash: 'x' } });
    try {
      await assert.rejects(prisma.user.create({ data: { name: 'Dup', email, passwordHash: 'x' } }), (e: any) => e.code === 'P2002');
      await assert.rejects(prisma.message.update({ where: { id: 'no-such-message' }, data: { status: 'read' } }), (e: any) => e.code === 'P2025');
      const db = (await lines()).filter((l) => l.category === 'database');
      const dup = db.find((l) => l.errorCode === 'P2002' && l.data.model === 'User')!;
      assert.deepEqual([dup.level, dup.event, dup.data.operation, typeof dup.durationMs], ['WARNING', 'database.error', 'create', 'number']);
      assert.match(dup.errorDetails, /Unique constraint/i);
      assert.equal(dup.reason, 'User.create would have created a duplicate (a unique value already exists)');
      assert.equal(dup.outcome, 'refused');
      // Where the query came from: this test (the caller), not the logging or database plumbing
      assert.match(dup.source, /^test\/logTrace\.test\.ts:\d+/);
      assert.ok(db.some((l) => l.errorCode === 'P2025' && l.data.model === 'Message' && l.data.operation === 'update'));
      // Once each (Prisma's engine event for the same query isn't logged again)
      assert.equal(db.filter((l) => l.event === 'database.engine').length, 0);
    } finally {
      await prisma.user.deleteMany({ where: { email } });
    }
  });
  test("the log table's own errors aren't reported (no loop when the database is the problem)", async () => {
    const before = (await lines()).filter((l) => l.category === 'database').length;
    await assert.rejects(prisma.logEntry.create({ data: { level: 'x'.repeat(50), category: 'system', event: 'e', message: 'm' } }));
    assert.equal((await lines()).filter((l) => l.category === 'database').length, before);
  });
});

describe('the running API writes its own log file', () => {
  // The API's entries are in its file (LOG_DIR); this test reads the same folder
  const apiLines = () => lines(env.logDir);

  test('an HTTP request: direction in, status, response size and duration, found by its X-Request-Id', async () => {
    const res = await fetch(`${API}/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'query { __typename }' }) });
    const requestId = res.headers.get('x-request-id')!;
    assert.ok(requestId);
    let entry: Line | undefined;
    for (let i = 0; i < 20 && !entry; i++) {
      await new Promise((r) => setTimeout(r, 100));
      entry = (await apiLines()).find((l) => l.requestId === requestId && l.event === 'http.request');
    }
    assert.ok(entry, `an http.request entry with ${requestId} in ${env.logDir}`);
    assert.deepEqual([entry!.direction, entry!.newStatus, entry!.outcome, entry!.response.status, entry!.data.method, entry!.data.path], ['in', 200, 'succeeded', 200, 'POST', '/graphql']);
    assert.match(entry!.reason, /The web app called the GraphQL API/);
    assert.match(entry!.source, /^src\/index\.ts:\d+/);
    assert.equal(typeof entry!.durationMs, 'number');
  });
  test('a Socket.IO connection without a valid token is refused and logged', async () => {
    const { io } = await import('socket.io-client');
    const marker = Date.now();
    await new Promise<void>((resolve) => {
      const socket = io(API, { auth: { token: 'not-a-real-token' }, transports: ['websocket'], reconnection: false });
      socket.on('connect_error', () => {
        socket.close();
        resolve();
      });
    });
    let entry: Line | undefined;
    for (let i = 0; i < 20 && !entry; i++) {
      await new Promise((r) => setTimeout(r, 100));
      entry = (await apiLines()).find((l) => l.event === 'socket.unauthorized' && Date.parse(l.timestamp) >= marker - 1000);
    }
    assert.ok(entry, 'socket.unauthorized logged');
    assert.deepEqual([entry!.level, entry!.direction, entry!.outcome, entry!.data.sentSignIn], ['WARNING', 'in', 'refused', true]);
    assert.match(entry!.reason, /sign-in that isn't valid any more/);
    assert.doesNotMatch(JSON.stringify(entry), /not-a-real-token/);
  });
});
