// A notification Firebase refuses, as it is logged: the error's code, its message with the device token, the
// notification's text (it can quote the customer), private keys and access tokens taken out, and its stack only when
// it held none of these. Never the error object. Push behaviour itself (ok / gone / failed) is unchanged.
// No database and nothing sent to Google: a fake Firebase sender, log writes captured. `npx tsx --test test/pushErrors.test.ts`
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

let push: typeof import('../src/services/push.js');
let logging: typeof import('../src/services/logging.js');
const saved: import('../src/services/logging.js').LogRecord[] = [];
const printed: string[] = [];
const consoleError = console.error;

const TOKEN = `dGVzdC1waG9uZS0x:APA91bH${'x7Yq'.repeat(30)}`;
const OTHER_TOKEN = `ZmFrZS1vdGhlcg:APA91bF${'Q9zK'.repeat(30)}`;
const PEM = `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDp6AbG\n-----END PRIVATE KEY-----\n`;
const ACCESS = `ya29.a0AfB_byC${'k3Lm'.repeat(20)}`;
const notice = { title: 'Ahmed Al Mansoori', body: 'My tyre size is 265/65 R17, call me', conversationId: 'c1', kind: 'message', collapseKey: 'c1' };
const fcmError = (message: string, code = 'messaging/internal-error', stack?: string) => {
  const e = Object.assign(new Error(message), { code, errorInfo: { code, message }, request: { token: TOKEN, notification: notice } });
  if (stack !== undefined) e.stack = stack;
  return e;
};
const failing = (err: unknown) => ({ send: async () => Promise.reject(err) });
const settle = () => new Promise((r) => setImmediate(r));
const everything = () => JSON.stringify(saved) + printed.join('\n');

before(async () => {
  push = await import('../src/services/push.js');
  logging = await import('../src/services/logging.js');
  logging.setLogWriter(async (r) => void saved.push(r));
  console.error = (...args: unknown[]) => void printed.push(args.map(String).join(' '));
});
after(() => {
  logging?.setLogWriter();
  console.error = consoleError;
});
beforeEach(() => {
  saved.length = 0;
  printed.length = 0;
});

describe('safeFcmError: what of a Firebase error may be logged', () => {
  test('the code, and the message with the token, the notification text, keys and access tokens taken out', () => {
    const err = fcmError(
      `Send to ${TOKEN} failed for "${notice.title}: ${notice.body}"; other ${OTHER_TOKEN}; key ${PEM} access ${ACCESS}; {"access_token":"abc123def456"} Authorization: Bearer ${ACCESS}`,
    );
    const safe = push.safeFcmError(err, TOKEN, notice);
    assert.equal(safe.code, 'messaging/internal-error');
    for (const secret of [TOKEN, OTHER_TOKEN, notice.title, notice.body, 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDp6AbG', ACCESS, 'abc123def456', 'APA91'])
      assert.ok(!safe.message.includes(secret), `message still has ${secret.slice(0, 20)}…`);
    assert.match(safe.message, /^Send to \[REDACTED\] failed for "\[REDACTED\]: \[REDACTED\]"; other \[device token\]; key \[private key\]/);
  });
  test('a stack with nothing secret is kept; one that quotes a secret is left out entirely', () => {
    const clean = push.safeFcmError(fcmError('Internal error', 'messaging/internal-error', 'Error: Internal error\n    at FirebaseMessagingError (messaging.js:10:5)'), TOKEN, notice);
    assert.deepEqual([clean.stack, clean.stackOmitted], ['Error: Internal error\n    at FirebaseMessagingError (messaging.js:10:5)', false]);
    const leaky = push.safeFcmError(fcmError('Internal error', 'messaging/internal-error', `Error: bad token ${TOKEN}\n    at x (y.js:1:1)`), TOKEN, notice);
    assert.deepEqual([leaky.stack, leaky.stackOmitted], [null, true]);
  });
  test('odd errors: no or strange code, a thrown string, nothing at all; long messages cut', () => {
    assert.equal(push.safeFcmError(Object.assign(new Error('x'), { code: { nested: TOKEN } }), TOKEN, notice).code, 'unknown');
    assert.equal(push.safeFcmError(Object.assign(new Error('x'), { code: `bad code ${TOKEN}` }), TOKEN, notice).code, 'unknown');
    assert.deepEqual(push.safeFcmError(`thrown ${TOKEN}`, TOKEN, notice), { code: 'unknown', message: 'thrown [REDACTED]', stack: null, stackOmitted: false });
    assert.deepEqual(push.safeFcmError(undefined, TOKEN, notice), { code: 'unknown', message: '(no message)', stack: null, stackOmitted: false });
    assert.ok(push.safeFcmError(new Error('word '.repeat(500)), TOKEN, notice).message.length <= 500);
  });
});

describe('sendOne: a refused notification is logged safely; behaviour unchanged', () => {
  test('failed: push.send_failed with the code, the redacted message and a clean stack; never the error object', async () => {
    const err = fcmError(`Upstream rejected ${TOKEN} with "${notice.body}" (${ACCESS})`, 'messaging/internal-error', 'Error: Upstream rejected\n    at send (messaging.js:1:1)');
    assert.deepEqual(await push.sendOne(failing(err), TOKEN, notice), { r: 'failed', code: 'messaging/internal-error' });
    await settle();
    const e = saved.find((r) => r.event === 'push.send_failed')!;
    assert.deepEqual([e.level, e.category, e.outcome, e.conversationId, e.errorCode], ['ERROR', 'system', 'failed', 'c1', 'messaging/internal-error']);
    assert.equal(e.errorDetails, 'Upstream rejected [REDACTED] with "[REDACTED]" ([access token])');
    assert.deepEqual(e.data, { kind: 'message', stack: 'Error: Upstream rejected\n    at send (messaging.js:1:1)', stackOmitted: false });
    assert.match(printed.join('\n'), /\[push\] FCM refused a notification: messaging\/internal-error Upstream rejected \[REDACTED\]/);
    assert.ok(!e.request && !e.response, 'no request or response attached');
    for (const secret of [TOKEN, notice.title, notice.body, ACCESS, 'errorInfo']) assert.ok(!everything().includes(secret), `logged ${secret.slice(0, 20)}…`);
  });
  test('a stack quoting the token is not logged', async () => {
    await push.sendOne(failing(fcmError('Internal error', 'messaging/internal-error', `Error: ${TOKEN}\n    at x`)), TOKEN, notice);
    await settle();
    const e = saved.find((r) => r.event === 'push.send_failed')!;
    assert.deepEqual(e.data, { kind: 'message', stack: null, stackOmitted: true });
    assert.ok(!everything().includes(TOKEN));
  });
  test('the code returned for the push.sent count is the same as before (unknown when there is none)', async () => {
    assert.deepEqual(await push.sendOne(failing(new Error('boom')), TOKEN, notice), { r: 'failed', code: 'unknown' });
  });
  test('ok and gone phones: same results as before, and no failure logged', async () => {
    assert.deepEqual(await push.sendOne({ send: async () => 'projects/test/messages/1' }, TOKEN, notice), { r: 'ok' });
    const gone = fcmError('Requested entity was not found.', 'messaging/registration-token-not-registered');
    assert.deepEqual(await push.sendOne(failing(gone), TOKEN, notice), { r: 'gone', code: 'messaging/registration-token-not-registered' });
    const badToken = fcmError('The registration token is not a valid FCM registration token', 'messaging/invalid-argument');
    assert.deepEqual(await push.sendOne(failing(badToken), TOKEN, notice), { r: 'gone', code: 'messaging/invalid-argument' });
    await settle();
    assert.equal(saved.filter((r) => r.event === 'push.send_failed').length, 0);
    assert.equal(printed.length, 0);
  });
});
