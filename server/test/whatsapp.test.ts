// Graph API calls (src/whatsapp.ts) against a mock Meta: a refusal keeps the message callers always showed, and
// now also Meta's numeric code, subcode and trace id (GraphApiError); every call is logged, success or failure,
// without the access token. No database needed (log writes are captured): `npx tsx --test test/whatsapp.test.ts`.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';

type Reply = { status: number; body: unknown };
let next: Reply = { status: 200, body: {} };
const mock = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(next.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(next.body));
  });
});

let wa: typeof import('../src/whatsapp.js');
let logging: typeof import('../src/services/logging.js');
const saved: import('../src/services/logging.js').LogRecord[] = [];
const account = { phoneNumberId: '1234567890', accessToken: 'EAAG-test-token-secret', wabaId: '999' };

before(async () => {
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  process.env.GRAPH_API_BASE = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`; // read when env.ts loads, below
  wa = await import('../src/whatsapp.js');
  logging = await import('../src/services/logging.js');
  logging.setLogWriter(async (r) => saved.push(r));
});
after(() => {
  logging?.setLogWriter();
  mock.close();
});

const lastLog = async () => {
  await new Promise((r) => setImmediate(r)); // logged without awaiting
  return saved.at(-1)!;
};

describe('Graph API errors keep Meta’s code', () => {
  test('a send refused by Meta throws GraphApiError with the same message plus code, subcode and trace id', async () => {
    next = { status: 400, body: { error: { message: 'Re-engagement message', type: 'OAuthException', code: 131047, error_subcode: 2494010, fbtrace_id: 'AbC123' } } };
    const err = await wa.sendText(account, '971500000000', 'hello').catch((e) => e);
    assert.ok(err instanceof wa.GraphApiError);
    assert.ok(err instanceof Error);
    assert.equal(err.message, 'Re-engagement message');
    assert.deepEqual([err.status, err.code, err.subcode, err.fbtraceId], [400, 131047, 2494010, 'AbC123']);
  });
  test('without an error body the message is the usual "Graph API error <status>" and the code is null', async () => {
    next = { status: 503, body: {} };
    const err = await wa.sendTemplate(account, '971500000000', 'welcome').catch((e) => e);
    assert.equal(err.message, 'Graph API error 503');
    assert.equal(err.code, null);
  });
  test('template calls keep preferring Meta’s user-facing message', async () => {
    next = { status: 400, body: { error: { message: 'Invalid parameter', error_user_msg: 'The template name is already used', code: 100, error_subcode: 2388024 } } };
    const err = await wa.createTemplate(account, { name: 'promo', language: 'en', category: 'MARKETING', components: [] }).catch((e) => e);
    assert.equal(err.message, 'The template name is already used');
    assert.deepEqual([err.code, err.subcode], [100, 2388024]);
  });
});

describe('every Graph API call is logged', () => {
  test('a successful send: SUCCESS with the message type and a duration, never the number, text or token', async () => {
    next = { status: 200, body: { messages: [{ id: 'wamid.OK1' }] } };
    assert.equal(await wa.sendText(account, '971500000000', 'secret text'), 'wamid.OK1');
    const log = await lastLog();
    assert.deepEqual([log.level, log.category, log.event, log.errorCode], ['SUCCESS', 'whatsapp', 'whatsapp.send', null]);
    assert.deepEqual(log.data, { type: 'text' });
    assert.equal(typeof log.durationMs, 'number');
    assert.doesNotMatch(JSON.stringify(log), /971500000000|secret text|EAAG-test-token-secret/);
  });
  test('a refused send: ERROR with Meta’s numeric code (e.g. 131049), HTTP status, subcode and trace id', async () => {
    next = { status: 400, body: { error: { message: 'Message failed to send because of healthy ecosystem engagement', code: 131049, fbtrace_id: 'Tr4ce' } } };
    await assert.rejects(wa.sendTemplateWithValues(account, '971500000000', 'promo', 'en', []));
    const log = await lastLog();
    assert.deepEqual([log.level, log.event, log.errorCode], ['ERROR', 'whatsapp.send', 131049]);
    assert.match(log.message, /healthy ecosystem engagement/);
    assert.deepEqual(log.data, { type: 'template', httpStatus: 400, subcode: null, fbtraceId: 'Tr4ce' });
  });
  test('uploads and template listing are logged under their own names', async () => {
    next = { status: 200, body: { id: 'media-1' } };
    assert.equal(await wa.uploadMedia(account, Buffer.from('abc'), 'image/png', 'a.png'), 'media-1');
    assert.equal((await lastLog()).event, 'whatsapp.upload_media');
    next = { status: 200, body: { data: [] } };
    assert.deepEqual(await wa.listTemplates(account), []);
    assert.equal((await lastLog()).event, 'whatsapp.list_templates');
  });
  test('a failing log write never turns a successful send into a failure', async () => {
    logging.setLogWriter(async () => {
      throw new Error('database down');
    });
    const quiet = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
    try {
      next = { status: 200, body: { messages: [{ id: 'wamid.OK2' }] } };
      assert.equal(await wa.sendText(account, '971500000000', 'hi'), 'wamid.OK2');
      await new Promise((r) => setImmediate(r));
    } finally {
      Object.assign(console, quiet);
      logging.setLogWriter(async (r) => saved.push(r));
    }
  });
});
