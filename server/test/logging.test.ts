// Centralized logging (services/logging.ts): sanitizing, levels, request ids, and that logging never breaks or
// blocks anything - when the database write fails the entry goes to the terminal instead. No server or LogEntry
// table needed (the writer is replaced): `npx tsx --test test/logging.test.ts`.
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import {
  type LogRecord,
  currentRequestId,
  logEvent,
  logMessageSend,
  outcomeForStatus,
  requestIdFrom,
  runWithRequest,
  sanitize,
  setLogWriter,
  setRequestUser,
} from '../src/services/logging.js';
import { statusError } from '../src/messages.js';

// Captures what the terminal is sent while fn runs
async function captureConsole(fn: () => Promise<unknown>) {
  const lines: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ['log', 'warn', 'error'] as const) console[k] = (...args: unknown[]) => void lines.push(`${k}: ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines;
}

after(() => setLogWriter());

describe('sanitize', () => {
  test('redacts passwords, tokens, secrets and auth headers at any depth, keeps everything else', () => {
    const out = sanitize({
      email: 'agent@example.com',
      password: 'hunter2',
      nested: { accessToken: 'EAAG123', apiKey: 'k', headers: { Authorization: 'Bearer abc.def' }, keep: 3 },
      list: [{ secret: 's' }, 'ok'],
    }) as any;
    assert.equal(out.email, 'agent@example.com');
    assert.equal(out.password, '[REDACTED]');
    assert.equal(out.nested.accessToken, '[REDACTED]');
    assert.equal(out.nested.apiKey, '[REDACTED]');
    assert.equal(out.nested.headers.Authorization, '[REDACTED]');
    assert.equal(out.nested.keep, 3);
    assert.deepEqual(out.list, [{ secret: '[REDACTED]' }, 'ok']);
  });
  test('removes bearer tokens and token/password query values written inside text', () => {
    const s = sanitize('call failed: Bearer EAAGsecretvalue at https://x/y?access_token=EAAG999&limit=5 password=abc') as string;
    assert.doesNotMatch(s, /EAAGsecretvalue|EAAG999|=abc/);
    assert.match(s, /Bearer \[REDACTED\]/);
    assert.match(s, /limit=5/);
    // Meta's own wording isn't a credential: kept as it is
    assert.equal(sanitize('Invalid OAuth access token - Cannot parse access token'), 'Invalid OAuth access token - Cannot parse access token');
    assert.equal(sanitize('OAuth EAAGabcdefghijklmnop123'), 'OAuth [REDACTED]');
  });
  test('cuts long strings and arrays, limits depth, survives cycles, buffers, errors and odd values', () => {
    assert.match(sanitize('x'.repeat(2000)) as string, /^x{500}… \(\+1500 chars\)$/);
    const arr = sanitize(Array.from({ length: 30 }, (_, i) => i)) as unknown[];
    assert.equal(arr.length, 21);
    assert.equal(arr[20], '… (+10 more)');
    assert.equal((sanitize({ a: { b: { c: { d: { e: 1 } } } } }) as any).a.b.c.d, '[Truncated]');
    const cyclic: any = { name: 'loop' };
    cyclic.self = cyclic;
    assert.equal((sanitize(cyclic) as any).self, '[Circular]');
    assert.equal(sanitize(Buffer.from('abc')), '[3 bytes]');
    assert.deepEqual(sanitize(Object.assign(new Error('boom'), { code: 131049 })), { name: 'Error', message: 'boom', code: 131049 });
    assert.equal(sanitize(10n), '10');
    const throwing = { get bad() { throw new Error('no'); } };
    assert.doesNotThrow(() => sanitize(throwing));
  });
});

test('outcomeForStatus: 5xx ERROR, 4xx WARNING, the rest SUCCESS', () => {
  assert.equal(outcomeForStatus(200), 'SUCCESS');
  assert.equal(outcomeForStatus(302), 'SUCCESS');
  assert.equal(outcomeForStatus(401), 'WARNING');
  assert.equal(outcomeForStatus(404), 'WARNING');
  assert.equal(outcomeForStatus(500), 'ERROR');
  assert.equal(outcomeForStatus(502), 'ERROR');
});

test('requestIdFrom reuses a sensible incoming id and replaces anything else', () => {
  assert.equal(requestIdFrom('abc12345-proxy'), 'abc12345-proxy');
  for (const bad of [undefined, '', 'short', 'has spaces in it', 'x'.repeat(65), '<script>alert(1)</script>'])
    assert.match(requestIdFrom(bad), /^[0-9a-f-]{36}$/);
});

describe('logEvent', () => {
  test('saves a sanitized entry carrying the request id and the signed-in person of the request', async () => {
    const saved: LogRecord[] = [];
    setLogWriter(async (r) => saved.push(r));
    await runWithRequest('req-test-0001', async () => {
      assert.equal(currentRequestId(), 'req-test-0001');
      setRequestUser({ userId: 'u1', workspaceId: 'w1' });
      await Promise.resolve(); // still the same request after awaiting
      await logEvent({ level: 'WARNING', category: 'auth', event: 'login.failed', message: 'Sign-in refused', errorCode: 'INVALID_CREDENTIALS', data: { email: 'a@b.c', password: 'nope' } });
    });
    assert.equal(saved.length, 1);
    assert.deepEqual(
      { ...saved[0] },
      {
        level: 'WARNING',
        category: 'auth',
        event: 'login.failed',
        message: 'Sign-in refused',
        requestId: 'req-test-0001',
        workspaceId: 'w1',
        userId: 'u1',
        errorCode: 'INVALID_CREDENTIALS',
        durationMs: null,
        data: { email: 'a@b.c', password: '[REDACTED]' },
      },
    );
  });
  test('explicit ids win over the request; outside a request they are null; numeric Meta codes become text', async () => {
    const saved: LogRecord[] = [];
    setLogWriter(async (r) => saved.push(r));
    await runWithRequest('req-test-0002', () => logEvent({ level: 'ERROR', category: 'whatsapp', event: 'x', message: 'm', workspaceId: 'w9', errorCode: 131049, durationMs: 12.6 }));
    await logEvent({ level: 'SUCCESS', category: 'http', event: 'y', message: 'm' });
    assert.equal(saved[0].workspaceId, 'w9');
    assert.equal(saved[0].errorCode, '131049');
    assert.equal(saved[0].durationMs, 13);
    assert.equal(saved[1].requestId, null);
    assert.equal(saved[1].data, null);
  });
  test('when the database write fails, the entry is printed to the terminal (with the reason once) and nothing throws', async () => {
    setLogWriter(async () => {
      throw new Error("Invalid `prisma.logEntry.create()` invocation:\n\nThe table `supportdb.LogEntry` does not exist in the current database.");
    });
    const lines = await captureConsole(async () => {
      await logEvent({ level: 'ERROR', category: 'message', event: 'message.status', message: "WhatsApp didn't deliver a message", errorCode: 131049 });
      await logEvent({ level: 'SUCCESS', category: 'auth', event: 'login.success', message: 'Signed in', data: { token: 'abc' } });
    });
    assert.equal(lines.filter((l) => l.includes("Couldn't save logs to the database")).length, 1, 'the reason is printed once, not per entry');
    assert.ok(lines.some((l) => l.includes('does not exist')));
    assert.ok(lines.some((l) => l.startsWith('error: [log, not saved] ERROR message message.status') && l.includes('131049')));
    assert.ok(lines.some((l) => l.startsWith('log: [log, not saved] SUCCESS auth login.success') && l.includes('[REDACTED]') && !l.includes('abc')));
  });
  test('a writer that throws synchronously, or input that breaks, never reaches the caller', async () => {
    setLogWriter(() => {
      throw new Error('sync failure');
    });
    await captureConsole(async () => {
      await assert.doesNotReject(logEvent({ level: 'ERROR', category: 'http', event: 'x', message: 'm' }));
      await assert.doesNotReject(logEvent(null as any));
    });
  });
  test('logMessageSend: SUCCESS when WhatsApp accepted it, ERROR with Meta’s code when it refused', async () => {
    const saved: LogRecord[] = [];
    setLogWriter(async (r) => saved.push(r));
    await logMessageSend({ workspaceId: 'w1', conversationId: 'c1', messageId: 'm1', type: 'text', userId: 'u1' });
    await logMessageSend({ workspaceId: 'w1', conversationId: 'c1', messageId: 'm2', type: 'template', error: Object.assign(new Error('Re-engagement message'), { code: 131047 }) });
    assert.deepEqual([saved[0].level, saved[0].event, saved[0].errorCode], ['SUCCESS', 'message.sent', null]);
    assert.deepEqual([saved[1].level, saved[1].event, saved[1].errorCode], ['ERROR', 'message.send_failed', '131047']);
    assert.match(saved[1].message, /Re-engagement message/);
  });
});

test("statusError reads Meta's numeric code from a failed status webhook (131049 healthy ecosystem engagement)", () => {
  const failed = {
    id: 'wamid.x',
    status: 'failed',
    errors: [{ code: 131049, title: 'This message was not delivered to maintain healthy ecosystem engagement.', error_data: { details: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.' } }],
  };
  assert.deepEqual(statusError(failed), {
    code: 131049,
    title: 'This message was not delivered to maintain healthy ecosystem engagement.',
    details: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
  });
  assert.equal(statusError({ id: 'wamid.y', status: 'delivered' }), null);
  assert.equal(statusError({ errors: [{ code: 'abc', title: 'odd' }] })?.code, null);
});
