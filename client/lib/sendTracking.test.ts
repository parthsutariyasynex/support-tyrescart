// Sending a reply, traced from the browser: the request id the server's logs share, the time limit, how a failure is
// described, the reports that wait while the server can't be reached, and what the chat shows meanwhile.
// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { GqlError, NetworkError, RequestTimeoutError, describeError, gql, isNetworkError, newRequestId, operationName } from './api';
import { MAX_QUEUED, createClientLog } from './clientLog';
import { pendingIn, pendingLabel, pendingReducer, type PendingSend } from './pendingSends';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

describe('the request id travels with the send', () => {
  test('X-Request-Id: the one given, a new one for any other change, none for reading', async () => {
    const seen: (string | null)[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get('X-Request-Id'));
      return ok({ x: 1 });
    }) as typeof fetch;
    await gql('mutation SendText { sendTextMessage { id } }', {}, { requestId: 'req-abc-12345' });
    await gql('mutation { markConversationRead }');
    await gql('{ conversations { id } }');
    assert.equal(seen[0], 'req-abc-12345');
    assert.match(seen[1]!, /^[A-Za-z0-9._:-]{8,64}$/, 'a fresh id the server accepts');
    assert.equal(seen[2], null);
  });
  test('ids are unique and in the form the server reuses', () => {
    const a = newRequestId();
    assert.notEqual(a, newRequestId());
    assert.match(a, /^[A-Za-z0-9._:-]{8,64}$/);
  });
  test("an operation's name from its query", () => {
    assert.equal(operationName('mutation SendText($input: SendTextInput!) { sendTextMessage(input: $input) { id } }'), 'sendTextMessage');
    assert.equal(operationName('  query { me { id } }'), 'me');
    assert.equal(operationName('not graphql'), null);
  });
});

describe('a send that gets no answer', () => {
  test('gives up after the time limit as RequestTimeoutError (a kind of NetworkError): "it may still have gone through"', async () => {
    // A request that never answers (it keeps the test process alive until the time limit aborts it, as a browser would)
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        const alive = setInterval(() => {}, 10);
        init.signal?.addEventListener('abort', () => {
          clearInterval(alive);
          reject(init.signal!.reason);
        });
      })) as typeof fetch;
    const err = await gql('mutation { sendTextMessage { id } }', {}, { timeoutMs: 50, reported: true }).catch((e) => e);
    assert.ok(err instanceof RequestTimeoutError);
    assert.ok(isNetworkError(err));
    assert.match(err.message, /No answer from the server within 0 s\. It may still have gone through/);
    assert.equal(describeError(err).kind, 'timeout');
  });
});

describe('failures described for the logs', () => {
  test('timeout, network, the API refusing it (with its code), and anything else', () => {
    assert.equal(describeError(new RequestTimeoutError(60_000)).kind, 'timeout');
    assert.equal(describeError(new NetworkError()).kind, 'network');
    assert.deepEqual(describeError(new GqlError('Assign this chat to yourself before replying', 'NOT_ASSIGNED')), {
      message: 'Assign this chat to yourself before replying',
      code: 'NOT_ASSIGNED',
      kind: 'api',
    });
    assert.equal(describeError(new Error('Request failed (502)')).kind, 'api');
    assert.equal(describeError(new TypeError('x is undefined')).kind, 'ui');
  });
});

describe('reports wait while the server is unreachable', () => {
  const setup = (deliver: (events: any[]) => Promise<boolean>) => {
    let stored: any[] = [];
    let clock = Date.parse('2026-10-26T12:00:00.000Z');
    const sent: any[][] = [];
    const log = createClientLog({
      send: async (events) => {
        const delivered = await deliver(events);
        if (delivered) sent.push(events);
        return delivered;
      },
      load: () => stored,
      save: (e) => void (stored = e),
      now: () => clock,
      page: () => '/inbox',
    });
    return { log, sent, stored: () => stored, tick: (ms: number) => void (clock += ms) };
  };
  test('delivered at once when the server answers', async () => {
    const s = setup(async () => true);
    await s.log.report({ event: 'send_started', requestId: 'r1', conversationId: 'c1', content: 'Hello' });
    assert.equal(s.sent.length, 1);
    assert.deepEqual([s.sent[0][0].event, s.sent[0][0].page, s.sent[0][0].delayedMs], ['send_started', '/inbox', 0]);
    assert.equal(s.stored().length, 0);
  });
  test('kept when it fails (or throws), sent later in order, marked with how late', async () => {
    let up = false;
    const s = setup(async () => {
      if (!up) throw new TypeError('fetch failed');
      return true;
    });
    await s.log.report({ event: 'send_started', requestId: 'r1' });
    s.tick(5000);
    await s.log.report({ event: 'send_failed', requestId: 'r1', error: { message: "Couldn't reach the server", kind: 'network' } });
    assert.equal(s.stored().length, 2, 'nothing lost, nothing thrown');
    up = true;
    s.tick(10_000);
    await s.log.flush();
    assert.deepEqual(s.sent[0].map((e) => [e.event, e.delayedMs]), [['send_started', 15_000], ['send_failed', 10_000]]);
    assert.equal(s.stored().length, 0);
  });
  test(`at most ${MAX_QUEUED} wait (oldest dropped), and they go 20 at a time`, async () => {
    let up = false;
    const s = setup(async () => up);
    for (let i = 0; i < MAX_QUEUED + 5; i++) await s.log.report({ event: 'api_error', requestId: `r${i}` });
    assert.equal(s.stored().length, MAX_QUEUED);
    assert.equal(s.stored()[0].requestId, 'r5');
    up = true;
    await s.log.flush();
    assert.deepEqual(s.sent.map((b) => b.length), [20, 20, 10]);
  });
});

describe('what the chat shows while a reply is on its way', () => {
  const start = (list: PendingSend[], requestId: string, conversationId = 'c1') =>
    pendingReducer(list, { type: 'start', send: { requestId, conversationId, body: 'Your tyres are ready', startedAt: 1 } });
  test('Sending… at once; gone when the saved message arrives', () => {
    let list = start([], 'r1');
    assert.deepEqual([list.length, list[0].state, pendingLabel(list[0])], [1, 'sending', 'Sending…']);
    list = pendingReducer(list, { type: 'done', requestId: 'r1' });
    assert.equal(list.length, 0);
  });
  test('refused or unreachable: "Not sent" with the reason; no answer in time: "Not confirmed"', () => {
    let list = start(start([], 'r1'), 'r2');
    list = pendingReducer(list, { type: 'fail', requestId: 'r1', error: 'Assign this chat to yourself before replying' });
    list = pendingReducer(list, { type: 'fail', requestId: 'r2', error: 'No answer from the server within 60 s.', unknown: true });
    assert.equal(pendingLabel(list[0]), 'Not sent: Assign this chat to yourself before replying');
    assert.equal(pendingLabel(list[1]), 'Not confirmed: No answer from the server within 60 s.');
    assert.equal(pendingReducer(list, { type: 'dismiss', requestId: 'r1' }).length, 1);
  });
  test('each chat shows only its own', () => {
    const list = start(start([], 'r1', 'c1'), 'r2', 'c2');
    assert.deepEqual(pendingIn(list, 'c2').map((p) => p.requestId), ['r2']);
  });
});
