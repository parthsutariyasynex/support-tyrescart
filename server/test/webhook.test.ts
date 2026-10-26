// Pure, DB-free tests for parsing a single WhatsApp webhook message. No server/DB needed: run with
// `npx tsx --test test/webhook.test.ts` or as part of `npm run test:e2e`.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, test } from 'node:test';
import { describeProviderError, parseWebhookMessage } from '../src/messages.js';
import { callsCount, signatureFailureReason, validSignature } from '../src/routes/webhook.js';

describe('parseWebhookMessage: never throws on a malformed/unexpected shape', () => {
  test('text message missing its text object degrades to a placeholder instead of throwing', () => {
    const msg = { from: '919876500000', id: 'wamid.malformed-1', type: 'text' }; // no `.text`
    assert.deepEqual(parseWebhookMessage(msg), { waId: '919876500000', name: undefined, waMessageId: 'wamid.malformed-1', type: 'text', body: '[text]' });
  });

  test('button message missing its button object degrades to a placeholder instead of throwing', () => {
    const msg = { from: '919876500000', id: 'wamid.malformed-2', type: 'button' }; // no `.button`
    assert.equal(parseWebhookMessage(msg).body, '[button]');
  });

  test('interactive message missing its interactive object degrades to a placeholder instead of throwing', () => {
    const msg = { from: '919876500000', id: 'wamid.malformed-3', type: 'interactive' }; // no `.interactive`
    assert.equal(parseWebhookMessage(msg).body, '[interactive]');
  });

  test('a normal, well-formed text message still parses exactly as before', () => {
    const msg = { from: '919876500000', id: 'wamid.ok-1', type: 'text', text: { body: 'Do you have 205/55 R16?' } };
    const contacts = [{ profile: { name: 'Riya' }, wa_id: '919876500000' }];
    assert.deepEqual(parseWebhookMessage(msg, contacts), { waId: '919876500000', name: 'Riya', waMessageId: 'wamid.ok-1', type: 'text', body: 'Do you have 205/55 R16?' });
  });

  test('an unrecognized/future message type still falls back to its existing bracketed placeholder', () => {
    const msg = { from: '919876500000', id: 'wamid.ok-2', type: 'reaction' };
    assert.equal(parseWebhookMessage(msg).body, '[reaction]');
  });
});

describe('signatureFailureReason: diagnostics only, never changes what validSignature accepts', () => {
  const secret = 'app-secret';
  const body = Buffer.from('{"entry":[]}');
  const sign = (s: string) => 'sha256=' + createHmac('sha256', s).update(body).digest('hex');

  test('names each failure case distinctly, and never leaks the secret or the (would-be) correct signature', () => {
    const reasons = {
      noSecretInProd: signatureFailureReason(body, undefined, '', true),
      noBody: signatureFailureReason(undefined, sign(secret), secret, true),
      noHeader: signatureFailureReason(body, undefined, secret, true),
      mismatch: signatureFailureReason(body, sign('wrong-secret'), secret, true),
    };
    const values = Object.values(reasons);
    assert.equal(new Set(values).size, values.length); // every case gets its own distinct message
    for (const r of values) {
      assert.equal(typeof r, 'string');
      assert.ok(!r.includes(secret)); // the real secret never appears in a logged reason
      assert.ok(!r.includes(sign(secret))); // neither does the correct HMAC value itself
    }
  });

  test('is purely advisory: it never overrides what validSignature itself accepts or rejects', () => {
    const cases: [Buffer | undefined, string | undefined, string, boolean][] = [
      [body, undefined, '', true], // no secret in production -> rejected
      [undefined, sign(secret), secret, true], // no body -> rejected
      [body, undefined, secret, true], // no header -> rejected
      [body, sign('wrong'), secret, true], // wrong secret -> rejected
      [body, sign(secret), secret, true], // correct signature -> accepted
      [body, undefined, '', false], // no secret outside production -> accepted
    ];
    for (const [b, h, s, isProd] of cases) {
      // signatureFailureReason must never throw regardless of whether validSignature would accept or reject
      assert.doesNotThrow(() => signatureFailureReason(b, h, s, isProd));
      assert.equal(typeof signatureFailureReason(b, h, s, isProd), 'string');
    }
    // Sanity check that the fixtures above actually exercise both outcomes
    assert.deepEqual(
      cases.map(([b, h, s, isProd]) => validSignature(b, h, s, isProd)),
      [false, false, false, false, true, true],
    );
  });
});

describe("Meta's errors on incoming messages", () => {
  const unsupported = {
    from: '971500000001',
    id: 'wamid.unsupported-1',
    type: 'unsupported',
    unsupported: { type: 'poll_creation' },
    errors: [{ code: 131051, title: 'Message type unknown', error_data: { details: 'Message type is currently not supported.' } }],
  };
  test('parseWebhookMessage carries errors through unchanged when present', () => {
    assert.deepEqual(parseWebhookMessage(unsupported).errors, unsupported.errors);
    assert.equal(parseWebhookMessage(unsupported).errors, unsupported.errors, 'the same array, unchanged');
  });
  test('…and has no errors field when there are none (or the list is empty)', () => {
    const plain = parseWebhookMessage({ from: '971500000001', id: 'wamid.ok-2', type: 'text', text: { body: 'Hi' } });
    assert.equal('errors' in plain, false);
    assert.equal('errors' in parseWebhookMessage({ ...unsupported, errors: [] }), false);
    assert.equal('errors' in parseWebhookMessage({ ...unsupported, errors: 'oops' }), false);
  });
});

describe('describeProviderError', () => {
  test('title and details: "title: details"', () => {
    assert.equal(describeProviderError({ code: 131051, title: 'Message type unknown', error_data: { details: 'Message type is currently not supported.' } }), 'Message type unknown: Message type is currently not supported.');
  });
  test('title only, or details only: just that one', () => {
    assert.equal(describeProviderError({ title: 'Message type unknown' }), 'Message type unknown');
    assert.equal(describeProviderError({ error_data: { details: 'Not supported.' } }), 'Not supported.');
    assert.equal(describeProviderError({ title: '', error_data: { details: 'Not supported.' } }), 'Not supported.');
  });
  test('neither: undefined (never a stray ": ")', () => {
    assert.equal(describeProviderError({}), undefined);
    assert.equal(describeProviderError({ code: 131051 }), undefined);
    assert.equal(describeProviderError({ title: '  ', error_data: {} }), undefined);
    assert.equal(describeProviderError(undefined), undefined);
    assert.equal(describeProviderError(null), undefined);
  });
  test('over 500 characters: cut to fit the column, no exception', () => {
    let out: string | undefined;
    assert.doesNotThrow(() => (out = describeProviderError({ title: 'x'.repeat(2000), error_data: { details: 'more' } })));
    assert.equal(Array.from(out!).length, 500);
    assert.match(out!, /^x{499}…$/);
    // Whole characters: an emoji is never split
    const emoji = describeProviderError({ title: '😀'.repeat(600) })!;
    assert.equal(Array.from(emoji).length, 500);
    assert.doesNotMatch(emoji, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
  test('secrets in the text are redacted like every logged value', () => {
    assert.equal(describeProviderError({ title: 'Bad request', error_data: { details: 'access_token=EAAGsecretvalue123 rejected' } }), 'Bad request: access_token=[REDACTED] rejected');
  });
});

describe('callsCount', () => {
  test('the number of calls in a populated array', () => {
    assert.equal(callsCount({ calls: [{ id: 'c1' }, { id: 'c2' }] }), 2);
  });
  test('0 for an empty array or an object without calls', () => {
    assert.equal(callsCount({ calls: [] }), 0);
    assert.equal(callsCount({}), 0);
  });
  test('0 when calls is not an array', () => {
    for (const calls of [{ id: 'c1' }, 'c1', 3, null]) assert.equal(callsCount({ calls }), 0);
  });
  test('0 for undefined (or null) input', () => {
    assert.equal(callsCount(undefined), 0);
    assert.equal(callsCount(null), 0);
  });
});
