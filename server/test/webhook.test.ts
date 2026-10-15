// Pure, DB-free tests for parsing a single WhatsApp webhook message. No server/DB needed: run with
// `npx tsx --test test/webhook.test.ts` or as part of `npm run test:e2e`.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, test } from 'node:test';
import { parseWebhookMessage } from '../src/messages.js';
import { signatureFailureReason, validSignature } from '../src/routes/webhook.js';

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
