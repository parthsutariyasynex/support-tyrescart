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
  waRef,
} from '../src/services/logging.js';
import { rawStatus, statusError } from '../src/messages.js';

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
    // Numeric ids stay numbers when JSON can hold them exactly; bigger ones stay exact as text
    assert.equal(sanitize(10n), 10);
    assert.equal(sanitize(2n ** 64n), '18446744073709551616');
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
    const { at, source, logId, ...rest } = saved[0];
    assert.match(source!, /^test\/logging\.test\.ts:\d+/, 'where it was logged');
    assert.ok(Number.isInteger(logId) && logId! > 0, 'numbered');
    assert.ok(at instanceof Date && Math.abs(at.getTime() - Date.now()) < 5000, 'stamped when made');
    assert.deepEqual(
      rest,
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
        direction: null,
        messageId: null,
        waMessageId: null,
        waMessageRef: null,
        conversationId: null,
        messageSent: null,
        customerReceived: null,
        deliveryStatus: null,
        content: null,
        previousStatus: null,
        newStatus: null,
        action: 'Sign a user in',
        reason: 'A sign-in attempt was refused',
        outcome: 'warning',
        request: null,
        response: null,
        errorDetails: null,
        data: { email: 'a@b.c', password: '[REDACTED]' },
      },
    );
  });
  test('explicit ids win over the request; outside a request they are null; numeric codes stay numbers, text codes stay text', async () => {
    const saved: LogRecord[] = [];
    setLogWriter(async (r) => saved.push(r));
    await runWithRequest('req-test-0002', () => logEvent({ level: 'ERROR', category: 'whatsapp', event: 'x', message: 'm', workspaceId: 'w9', errorCode: 131049, durationMs: 12.6 }));
    await logEvent({ level: 'SUCCESS', category: 'http', event: 'y', message: 'm' });
    assert.equal(saved[0].workspaceId, 'w9');
    assert.equal(saved[0].errorCode, 131049);
    const { toRecord } = await import('../src/services/logging.js');
    for (const [given, kept] of [['P2002', 'P2002'], ['FORBIDDEN', 'FORBIDDEN'], ['190', 190], [401, 401], [null, null]] as const)
      assert.equal(toRecord({ level: 'ERROR', category: 'http', event: 'x', message: 'm', errorCode: given }).errorCode, kept);
    // A status is a number when it is one (HTTP), text otherwise; ids are never turned into numbers
    const r = toRecord({ level: 'SUCCESS', category: 'http', event: 'x', message: 'm', status: 200, previousStatus: 'sent', messageId: '12345', waMessageId: 'wamid.123' });
    // WhatsApp's id only as its one-way reference (a wamid holds the customer's number)
    const { waRef } = await import('../src/services/logging.js');
    assert.deepEqual([r.newStatus, r.previousStatus, r.messageId, r.waMessageRef], [200, 'sent', '12345', waRef('wamid.123')]);
    assert.match(r.waMessageRef!, /^wa:[0-9a-f]{16}$/);
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
    assert.deepEqual([saved[1].level, saved[1].event, saved[1].errorCode], ['ERROR', 'message.send_failed', 131047]);
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

test("a failed status's raw copy: saved under response with its nested details; ids as references, no number or secret", async () => {
  const saved: LogRecord[] = [];
  setLogWriter(async (r) => saved.push(r));
  const failed = {
    id: 'wamid.HBgMOTcxNTAwMDAwMDAwFQIAERgS',
    status: 'failed',
    timestamp: '1793000000',
    recipient_id: '971500000000',
    conversation: { id: 'conv-abc123', origin: { type: 'marketing' } },
    biz_opaque_callback_data: 'token=supersecretvalue123',
    errors: [{ code: 131026, title: 'Message undeliverable', message: 'Message undeliverable', error_data: { details: 'Receiver is incapable of receiving this message' }, href: 'https://developers.facebook.com/docs/whatsapp' }],
  };
  await logEvent({ level: 'ERROR', category: 'message', event: 'message.status', message: 'not delivered', response: rawStatus(failed) });
  const raw = saved[0].response as any;
  // Nested error detail survives (in data, depth 4 would have cut it to "[Truncated]")
  assert.equal(raw.errors[0].error_data.details, 'Receiver is incapable of receiving this message');
  assert.deepEqual([raw.errors[0].code, raw.errors[0].title, raw.conversation.origin.type], [131026, 'Message undeliverable', 'marketing']);
  assert.equal((sanitize({ raw: failed }) as any).raw.errors[0].error_data, '[Truncated]', 'why it goes under response, not data');
  // Identifiers become references; the customer's number and secrets are never stored
  assert.deepEqual([raw.id, raw.conversation.id, raw.recipient_id], [waRef(failed.id), waRef('conv-abc123'), '[REDACTED]']);
  assert.match(raw.biz_opaque_callback_data, /token=\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(saved[0]), /wamid\.HBgM|971500000000|conv-abc123|supersecretvalue123/);
  // Nothing to copy: no response
  assert.equal(rawStatus(null), null);
});

describe('every log explains itself', () => {
  test('every event name the server logs has an action and a reason (no entry is ever unexplained)', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { eventInfo } = await import('../src/services/logging.js');
    const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
    const files: string[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) e.isDirectory() ? await walk(path.join(d, e.name)) : e.name.endsWith('.ts') && files.push(path.join(d, e.name));
    };
    await walk(decodeURIComponent(root));
    const names = new Set<string>();
    const EVENT = /['`]((?:http|graphql|login|permission|message|automation|conversation|live|webhook|socket|database|activity|email|file|job|settings|logs|whatsapp|client)\.[a-z_]+)['`]/g;
    const NOT_EVENTS = new Set(['socket.io']); // the library's name in imports
    for (const f of files) for (const m of (await readFile(f, 'utf8')).matchAll(EVENT)) if (!NOT_EVENTS.has(m[1])) names.add(m[1]);
    assert.ok(names.size >= 40, `found ${names.size} event names`);
    const missing = [...names].filter((n) => !eventInfo(n));
    assert.deepEqual(missing, [], 'events without an action and reason');
    // Dynamic Meta API calls get theirs from the whatsapp.* rule
    assert.match(eventInfo('whatsapp.upload_template_sample')!.action, /Meta's WhatsApp API \(upload_template_sample\)/);
  });
  test('defaults fill the action, reason and outcome; call sites can be more specific; status → newStatus', async () => {
    const { toRecord } = await import('../src/services/logging.js');
    const plain = toRecord({ level: 'ERROR', category: 'message', event: 'message.send_failed', message: 'x' });
    assert.deepEqual([plain.action, plain.reason, plain.outcome], ['Send a message to the customer on WhatsApp', 'A message was sent from the chat and WhatsApp refused it', 'failed']);
    const specific = toRecord({ level: 'SUCCESS', category: 'message', event: 'message.status', message: 'x', reason: 'Because', outcome: 'updated', previousStatus: 'sent', status: 'delivered' });
    assert.deepEqual([specific.reason, specific.outcome, specific.previousStatus, specific.newStatus], ['Because', 'updated', 'sent', 'delivered']);
    const unknown = toRecord({ level: 'SUCCESS', category: 'system', event: 'brand.new_event', message: 'x' });
    assert.deepEqual([unknown.action, unknown.reason], ['brand.new_event', 'Not described']);
  });
  test('callerSource: the first frame outside the logging plumbing, as file:line function', async () => {
    const { callerSource } = await import('../src/services/logging.js');
    const stack = [
      'Error',
      '    at callerSource (/x/server/src/services/logging.ts:120:10)',
      '    at logEvent (/x/server/src/services/logging.ts:300:5)',
      '    at $allOperations (/x/server/src/prisma.ts:30:9)',
      '    at async sendMessage (/x/server/src/services/inbox.ts:465:7)',
      '    at async /x/server/src/routes/inbox.ts:50:3',
    ].join('\n');
    assert.equal(callerSource(stack), 'src/services/inbox.ts:465 sendMessage');
    assert.equal(callerSource(['Error', '    at /x/server/src/routes/inbox.ts:50:3'].join('\n')), 'src/routes/inbox.ts:50');
    assert.equal(callerSource(['Error', '    at node:internal/process:1:1', '    at waitForActual (node:assert:615:5)'].join('\n')), null);
    assert.equal(callerSource(['Error', '    at async Module.saveIncoming (/x/server/src/messages.ts:159:3)'].join('\n')), 'src/messages.ts:159 saveIncoming');
    assert.equal(callerSource(['Error', '    at TestContext.<anonymous> (/x/server/test/a.test.ts:5:1)'].join('\n')), 'test/a.test.ts:5');
  });
});
