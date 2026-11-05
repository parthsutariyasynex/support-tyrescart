// Connecting a WhatsApp number: the 7 checks with Meta (verifyWhatsAppWithMeta), against a mock of Meta's Graph API
// started here, so nothing reaches WhatsApp. No API server or database needed.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';

const APP_ID = 'app-777';
const TOKEN = 'EAAG-system-user-token';
let debug: any;
let wabaSubscribed: boolean;
let appFields: string[];
let posts: string[] = [];

const server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  const path = url.pathname.replace(/^\/v[\d.]+\//, '');
  const auth = req.headers.authorization;
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const appAuth = auth === `Bearer ${APP_ID}|app-secret`;
  if (path === 'debug_token') return appAuth ? send(200, { data: debug }) : send(400, { error: { message: 'bad app token' } });
  if (path === `${APP_ID}/subscriptions`)
    return appAuth ? send(200, { data: [{ object: 'whatsapp_business_account', active: true, callback_url: 'https://x/webhook', fields: appFields.map((name) => ({ name })) }] }) : send(400, {});
  if (auth !== `Bearer ${TOKEN}`) return send(401, { error: { message: 'Invalid OAuth access token.' } });
  if (path === 'me') return send(200, { id: 'su1', name: 'tyrescart-bot' });
  if (path === 'waba-1') return send(200, { id: 'waba-1', name: 'TyresCart' });
  if (path === 'waba-1/phone_numbers') return send(200, { data: [{ id: 'pn-1', display_phone_number: '+1 555-883-8811', verified_name: 'TyresCart' }] });
  if (path === 'waba-1/subscribed_apps') {
    if (req.method === 'POST') {
      posts.push(path);
      wabaSubscribed = true;
      return send(200, { success: true });
    }
    return send(200, { data: wabaSubscribed ? [{ whatsapp_business_api_data: { id: APP_ID, name: 'app' } }] : [] });
  }
  send(404, { error: { message: `Unsupported get request: ${path}` } });
});

let verify: typeof import('../src/services/settings.js').verifyWhatsAppWithMeta;

before(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  process.env.GRAPH_API_BASE = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.META_APP_ID = APP_ID;
  process.env.META_APP_SECRET = 'app-secret';
  ({ verifyWhatsAppWithMeta: verify } = await import('../src/services/settings.js'));
});
after(() => server.close());
beforeEach(() => {
  debug = { is_valid: true, app_id: APP_ID, type: 'SYSTEM_USER', expires_at: 0, scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'] };
  wabaSubscribed = true;
  appFields = ['messages'];
  posts = [];
});

const input = { wabaId: 'waba-1', phoneNumberId: 'pn-1', accessToken: TOKEN };
async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (e: any) {
    return { code: e.code as string, message: e.message as string };
  }
  assert.fail('expected the checks to fail');
}

describe('verifyWhatsAppWithMeta', () => {
  test('passes all 7 checks and returns the number Meta reports', async () => {
    const { checks, displayPhone } = await verify(input);
    assert.equal(checks.length, 7);
    assert.ok(checks.every((c) => c.ok));
    assert.equal(displayPhone, '+1 555-883-8811');
  });

  test('1: a token Meta rejects is INVALID_CREDENTIALS', async () => {
    const f = await failure(verify({ ...input, accessToken: 'expired-temporary-token' }));
    assert.equal(f.code, 'INVALID_CREDENTIALS');
    assert.match(f.message, /Check 1 of 7/);
  });

  test("2: a token of another app is refused", async () => {
    debug.app_id = 'someone-else';
    assert.match((await failure(verify(input))).message, /Check 2 of 7.*someone-else/);
  });

  test('3: temporary and non-System-User tokens are refused', async () => {
    debug.expires_at = Math.floor(Date.now() / 1000) + 3600;
    assert.match((await failure(verify(input))).message, /Check 3 of 7.*expires/);
    debug.expires_at = 0;
    debug.type = 'USER';
    assert.match((await failure(verify(input))).message, /Check 3 of 7.*USER token/);
  });

  test('4: missing permissions are named', async () => {
    debug.scopes = ['whatsapp_business_messaging'];
    assert.match((await failure(verify(input))).message, /Check 4 of 7.*whatsapp_business_management/);
  });

  test('5 and 6: unknown account, or a number outside it, are refused', async () => {
    assert.match((await failure(verify({ ...input, wabaId: 'waba-x' }))).message, /Check 5 of 7/);
    assert.match((await failure(verify({ ...input, phoneNumberId: 'pn-other' }))).message, /Check 6 of 7.*pn-other/);
  });

  test('a failure carries the checks that ran (for the audit log)', async () => {
    debug.scopes = [];
    try {
      await verify(input);
      assert.fail('expected a failure');
    } catch (e: any) {
      assert.deepEqual(
        e.checks.map((c: any) => [c.name, c.ok]),
        [['Access token', true], ['Meta app', true], ['Permanent token', true], ['Permissions', false]],
      );
    }
  });

  test('7: subscribes the app to the account when needed, and needs the "messages" webhook field', async () => {
    wabaSubscribed = false;
    await verify(input);
    assert.deepEqual(posts, ['waba-1/subscribed_apps']);
    appFields = ['message_template_status_update'];
    assert.match((await failure(verify(input))).message, /Check 7 of 7.*messages/);
  });
});

describe('redactSecrets (audit log)', () => {
  let redact: typeof import('../src/services/whatsappAudit.js').redactSecrets;
  before(async () => {
    ({ redactSecrets: redact } = await import('../src/services/whatsappAudit.js'));
  });

  test('removes tokens, app tokens, JWTs, Bearer headers and key=value secrets', () => {
    const text = [
      'token EAAVO789jcXgBS8ww0zZA0ACVPEJbICAZCmJFsfgrftgXbTZBpOu used',
      'app 1494166767104376|c8403ef2cc5f217fc233e1fb021a7a7c',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig-nature_x',
      'Authorization: Bearer abc.def',
      'access_token=abc123secret&x=1',
      '{"accessToken":"plain-token-value","password": "hunter22"}',
    ].join('\n');
    const out = redact(text)!;
    for (const leaked of ['EAAVO789', 'c8403ef2cc', 'eyJhbGci', 'abc.def', 'abc123secret', 'plain-token-value', 'hunter22']) assert.ok(!out.includes(leaked), `leaked ${leaked}: ${out}`);
    assert.match(out, /access_token=\[redacted\]/);
  });

  test('removes the submitted token and the server app secret wherever they appear', () => {
    assert.equal(redact('failed for short-tok-123 now', ['short-tok-123']), 'failed for [redacted] now');
    assert.equal(redact('secret app-secret leaked'), 'secret [redacted] leaked');
  });

  test('leaves ordinary check messages alone', () => {
    const msg = 'Check 3 of 7 failed (Permanent token): This is a USER token. Generate a System User token in Meta Business Settings';
    assert.equal(redact(msg), msg);
  });
});
