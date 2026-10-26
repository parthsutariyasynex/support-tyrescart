// A reply sent from the inbox, traced on the server: the browser's own reports (POST /client-log) become log entries
// under the send's request id; the GraphQL send records which chat it was for and what it answered (never the text);
// and the API logs receiving the reply before any check, so a refusal is traced too.
// No database: log writes are captured. `npx tsx --test test/sendFlow.test.ts`
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

let logging: typeof import('../src/services/logging.js');
let clientLog: typeof import('../src/routes/clientLog.js');
let shared: typeof import('../src/graphql/shared.js');
let errors: typeof import('../src/services/errors.js');
const saved: import('../src/services/logging.js').LogRecord[] = [];
const auth = { userId: 'u1', workspaceId: 'w1' };

before(async () => {
  logging = await import('../src/services/logging.js');
  clientLog = await import('../src/routes/clientLog.js');
  shared = await import('../src/graphql/shared.js');
  errors = await import('../src/services/errors.js');
  logging.setLogWriter(async (r) => saved.push(r));
});
after(() => logging?.setLogWriter());
const settle = () => new Promise((r) => setImmediate(r));

describe("the browser's reports", () => {
  test("send_started: the reply's text, chat and the send's own request id", () => {
    const [e] = clientLog.clientEvents({ events: [{ event: 'send_started', requestId: 'req-send-0001', conversationId: 'c1', content: 'Your tyres are ready', at: '2026-10-26T12:10:00.000Z', page: '/inbox' }] }, auth);
    assert.deepEqual([e.level, e.category, e.event, e.requestId, e.conversationId, e.content, e.userId, e.workspaceId], ['SUCCESS', 'client', 'client.send_started', 'req-send-0001', 'c1', 'Your tyres are ready', 'u1', 'w1']);
    assert.match(e.message, /Send pressed/);
    assert.deepEqual(e.data, { clientAt: '2026-10-26T12:10:00.000Z', page: '/inbox', operation: null });
  });
  test('send_failed: the actual reason, and how serious by kind (never reached / no answer / refused / WhatsApp)', () => {
    const events = clientLog.clientEvents(
      {
        events: [
          { event: 'send_failed', requestId: 'r-network-1', durationMs: 120, error: { message: "Couldn't reach the server.", kind: 'network' }, delayedMs: 30000 },
          { event: 'send_failed', requestId: 'r-timeout-1', durationMs: 60000, error: { message: 'No answer from the server within 60 s.', kind: 'timeout' } },
          { event: 'send_failed', requestId: 'r-refused-1', error: { message: 'Assign this chat to yourself before replying', code: 'NOT_ASSIGNED', kind: 'api' } },
          { event: 'send_failed', requestId: 'r-whatsapp-1', messageId: 'm1', status: 'failed', error: { message: '(#131047) Re-engagement message', kind: 'whatsapp' } },
        ],
      },
      auth,
    );
    assert.deepEqual(events.map((e) => [e.level, e.outcome]), [['WARNING', 'failed'], ['WARNING', 'unknown'], ['ERROR', 'failed'], ['ERROR', 'failed']]);
    assert.match(events[0].message, /never reached the API after 0\.1 s/);
    assert.equal((events[0].data as any).reportedLateMs, 30000, 'reported later, when the server could be reached');
    assert.match(events[1].message, /may or may not have been sent/);
    assert.deepEqual([events[2].errorCode, events[2].errorDetails], ['NOT_ASSIGNED', 'Assign this chat to yourself before replying']);
    assert.match(events[3].message, /saved but WhatsApp refused it: \(#131047\) Re-engagement message/);
    assert.deepEqual([events[3].messageId, events[3].deliveryStatus], ['m1', 'failed']);
  });
  test('only known events, at most 20, and ids that look like ids', () => {
    assert.throws(() => clientLog.clientEvents({ events: [{ event: 'delete_everything' }] }, auth), /Unknown client event/);
    assert.throws(() => clientLog.clientEvents({}, auth), /Expected \{ events/);
    assert.throws(() => clientLog.clientEvents({ events: Array.from({ length: 21 }, () => ({ event: 'error' })) }, auth), /At most 20/);
    const [e] = clientLog.clientEvents({ events: [{ event: 'error', requestId: '<script>', conversationId: 'c 1', error: { message: 'x'.repeat(5000), kind: 'ui' } }] }, auth);
    assert.deepEqual([e.requestId, e.conversationId, e.errorDetails!.length], [null, null, 1000]);
  });
  test("the browser's request id is the one the API logs the send under (X-Request-Id is reused)", () => {
    assert.equal(logging.requestIdFrom('2f1c9a7e-4b1d-4c7e-9a51-3d2e1f0a9b8c'), '2f1c9a7e-4b1d-4c7e-9a51-3d2e1f0a9b8c');
    assert.notEqual(logging.requestIdFrom('<bad id>'), '<bad id>');
  });
});

describe('the GraphQL send', () => {
  const op = { name: 'sendTextMessage', type: 'mutation', conversationId: 'c1', messageId: null };
  test('operationOf: the chat from the variables, never the rest (the text)', () => {
    const info = { fieldName: 'sendTextMessage', operation: { operation: 'mutation' }, variableValues: { input: { conversationId: 'c1', body: 'secret reply' } } } as any;
    assert.deepEqual(shared.operationOf(info), { name: 'sendTextMessage', type: 'mutation', conversationId: 'c1', messageId: null });
  });
  test("answered: the saved message's id and status (and WhatsApp's reason), linked to the chat", async () => {
    saved.length = 0;
    await shared.run(async () => ({ id: 'm1', status: 'failed', error: '(#131047) Re-engagement message', body: 'secret reply' }), op);
    await settle();
    const e = saved.find((r) => r.event === 'graphql.mutation')!;
    assert.deepEqual([e.conversationId, e.messageId, e.message], ['c1', 'm1', 'sendTextMessage succeeded (message failed)']);
    assert.deepEqual(e.response, { id: 'm1', status: 'failed', error: '(#131047) Re-engagement message' });
    assert.doesNotMatch(JSON.stringify(e), /secret reply/, 'the text is logged once, by the send itself');
  });
  test('refused: the reason, linked to the chat', async () => {
    saved.length = 0;
    await assert.rejects(shared.run(async () => {
      throw new errors.AppError('Assign this chat to yourself before replying (New Leads → Assign to Me).', 409, 'NOT_ASSIGNED');
    }, op));
    await settle();
    const e = saved.find((r) => r.event === 'graphql.mutation')!;
    assert.deepEqual([e.level, e.outcome, e.errorCode, e.conversationId], ['WARNING', 'refused', 'NOT_ASSIGNED', 'c1']);
    assert.match(e.errorDetails!, /Assign this chat to yourself/);
  });
});

describe('the API receiving a reply', () => {
  test('logged before any check, with the text and chat: a reply refused right away is traced too', async () => {
    const inbox = await import('../src/services/inbox.js');
    saved.length = 0;
    // An empty body is refused by validation, before anything is read from the database
    await logging.runWithRequest('req-send-0002', () => assert.rejects(inbox.sendMessage('w1', 'c1', { type: 'text', body: '' }, 'u1')));
    await settle();
    const e = saved.find((r) => r.event === 'message.send_requested')!;
    assert.deepEqual([e.requestId, e.conversationId, e.userId, e.newStatus, e.direction], ['req-send-0002', 'c1', 'u1', 'requested', 'out']);
    assert.equal(e.content, null, 'an empty body has no text');
    saved.length = 0;
    await logging.runWithRequest('req-send-0003', () => assert.rejects(inbox.sendMessage('w1', 'c1', { type: 'nope', body: 'Hello there' }, 'u1')));
    await settle();
    assert.equal(saved.find((r) => r.event === 'message.send_requested')!.content, 'Hello there');
  });
});
