// WhatsApp templates: reading Meta's format, filling in values, the send/create payloads, and the services against a
// mock of Meta's Graph API (started here, so nothing reaches WhatsApp). The API server must be running (API_URL)
// for sign-ups; the services run in this process.
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { after, before, describe, test } from 'node:test';

// --- a mock Graph API: records every request, answers like Meta
type Req = { method: string; path: string; query: URLSearchParams; headers: IncomingMessage['headers']; body: Buffer };
const seen: Req[] = [];
const META_TEMPLATES = [
  {
    id: 'tpl_order',
    name: 'order_ready',
    language: 'en',
    category: 'UTILITY',
    status: 'APPROVED',
    parameter_format: 'POSITIONAL',
    components: [
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: 'Hi {{1}}, your order {{2}} is ready for fitting.' },
      { type: 'FOOTER', text: 'TyresCart' },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'URL', text: 'Track order', url: 'https://tyrescart.ae/orders/{{1}}' },
          { type: 'QUICK_REPLY', text: 'Thanks' },
        ],
      },
    ],
  },
  { id: 'tpl_hello', name: 'hello_world', language: 'en_US', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hello from TyresCart' }] },
  {
    id: 'tpl_named',
    name: 'promo',
    language: 'en',
    category: 'MARKETING',
    status: 'APPROVED',
    parameter_format: 'NAMED',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Hi {{first_name}}' },
      { type: 'BODY', text: 'Use your code for {{discount}} off this week.' },
      { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE', text: 'Copy offer code' }] },
    ],
  },
  { id: 'tpl_rej', name: 'old_offer', language: 'en', category: 'MARKETING', status: 'REJECTED', rejected_reason: 'PROMOTIONAL', components: [{ type: 'BODY', text: 'Big sale' }] },
  { id: 'tpl_car', name: 'carousel_x', language: 'en', category: 'MARKETING', status: 'APPROVED', components: [{ type: 'BODY', text: 'See' }, { type: 'CAROUSEL', cards: [] }] },
];
const mock = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const r: Req = { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body: Buffer.concat(chunks) };
    seen.push(r);
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (r.method === 'GET' && r.path.endsWith('/message_templates')) {
      const approvedOnly = r.query.get('status') === 'APPROVED';
      return json(200, { data: META_TEMPLATES.filter((t) => !approvedOnly || t.status === 'APPROVED') });
    }
    if (r.method === 'POST' && r.path.endsWith('/message_templates')) {
      const body = JSON.parse(r.body.toString() || '{}');
      if (body.name === 'meta_refuses') return json(400, { error: { message: 'Template name already exists', error_user_msg: 'A template with this name already exists' } });
      return json(200, { id: 'new_tpl_1', status: 'PENDING', category: body.category });
    }
    if (r.method === 'DELETE' && r.path.endsWith('/message_templates')) return json(200, { success: true });
    if (r.method === 'POST' && r.path.endsWith('/messages')) return json(200, { messages: [{ id: `wamid.mock-${Date.now()}-${Math.random().toString(36).slice(2)}` }] });
    if (r.method === 'POST' && r.path.endsWith('/media')) return json(200, { id: 'media-123' });
    if (r.method === 'POST' && r.path.endsWith('/uploads')) return json(200, { id: 'upload:SESSION1' });
    if (r.method === 'POST' && r.path.includes('upload:SESSION1')) return json(200, { h: 'HANDLE-XYZ' });
    if (r.method === 'POST' && r.path.endsWith('/tpl_rej')) return json(200, { success: true });
    json(404, { error: { message: `mock: no route for ${r.method} ${r.path}` } });
  });
});
let mockUrl = '';

const API = process.env.API_URL ?? 'http://localhost:5001';
const run = Date.now();
async function gql(query: string, variables: object = {}, token?: string) {
  const res = await fetch(`${API}/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  const j = (await res.json()) as { data?: any; errors?: { message: string }[] };
  if (j.errors) throw new Error(j.errors[0].message);
  return j.data;
}

let model: typeof import('../src/services/templateModel.js');
let svc: typeof import('../src/services/templates.js');
let prisma: typeof import('../src/prisma.js')['prisma'];

before(async () => {
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
  const addr = mock.address() as { port: number };
  mockUrl = `http://127.0.0.1:${addr.port}`;
  process.env.GRAPH_API_BASE = mockUrl; // read when env.ts loads, below
  process.env.META_APP_ID = 'app-42';
  model = await import('../src/services/templateModel.js');
  svc = await import('../src/services/templates.js');
  prisma = (await import('../src/prisma.js')).prisma;
});
after(async () => {
  mock.close();
  await prisma?.$disconnect();
});

describe('template model', () => {
  test('variables and Meta templates as the app reads them', () => {
    assert.deepEqual(model.variablesOf('Hi {{1}}, order {{2}} for {{1}}'), ['1', '2']);
    assert.deepEqual(model.variablesOf('Hi {{ first_name }}'), ['first_name']);
    const t = model.parseTemplate(META_TEMPLATES[0]);
    assert.equal(t.header?.format, 'IMAGE');
    assert.deepEqual(t.body.variables, ['1', '2']);
    assert.equal(t.footer, 'TyresCart');
    assert.deepEqual(t.buttons.map((b) => [b.type, b.variables]), [['URL', ['1']], ['QUICK_REPLY', []]]);
    assert.equal(t.sendable, true);
    assert.equal(model.parseTemplate(META_TEMPLATES[3]).rejectedReason, 'PROMOTIONAL');
    const car = model.parseTemplate(META_TEMPLATES[4]);
    assert.equal(car.sendable, false);
    assert.match(car.unsupportedReason ?? '', /carousel/);
  });

  test('send payload: header media, body values, URL button; the chat text', () => {
    const t = model.parseTemplate(META_TEMPLATES[0]);
    const values = { header: {}, body: { '1': 'Amir', '2': 'TC-1042' }, buttons: { '0': 'TC-1042' } };
    assert.deepEqual(model.buildSendComponents(t, values, { id: 'media-1' }), [
      { type: 'header', parameters: [{ type: 'image', image: { id: 'media-1' } }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Amir' }, { type: 'text', text: 'TC-1042' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'TC-1042' }] },
    ]);
    assert.equal(model.renderTemplate(t, values), 'Hi Amir, your order TC-1042 is ready for fitting.\n\nTyresCart\n\n[Track order] [Thanks]');
    assert.throws(() => model.buildSendComponents(t, { ...values, body: { '1': 'Amir' } }, { id: 'm' }), /Fill in \{\{2\}\}/);
    assert.throws(() => model.buildSendComponents(t, values), /header image/);
  });

  test('named variables and a coupon button', () => {
    const t = model.parseTemplate(META_TEMPLATES[2]);
    const values = { header: { first_name: 'Bina' }, body: { discount: '15%' }, buttons: { '0': 'TYRE15' } };
    assert.deepEqual(model.buildSendComponents(t, values), [
      { type: 'header', parameters: [{ type: 'text', text: 'Bina', parameter_name: 'first_name' }] },
      { type: 'body', parameters: [{ type: 'text', text: '15%', parameter_name: 'discount' }] },
      { type: 'button', sub_type: 'copy_code', index: '0', parameters: [{ type: 'coupon_code', coupon_code: 'TYRE15' }] },
    ]);
    assert.equal(model.renderTemplate(t, values).split('\n\n')[0], 'Hi Bina');
  });

  test('editor: rules checked like Meta, payloads built', () => {
    const err = (spec: object) => {
      const r = model.templateSpecSchema.safeParse(spec);
      return r.success ? 'ok' : r.error.issues.map((i) => i.message).join(' | ');
    };
    const base = { name: 'order_ready', category: 'UTILITY', language: 'en', body: 'Hi {{1}}, order {{2}} is ready.', bodyExamples: ['Amir', 'TC-1'] };
    assert.equal(err(base), 'ok');
    assert.match(err({ ...base, name: 'Order Ready' }), /lowercase/);
    assert.match(err({ ...base, bodyExamples: ['Amir'] }), /sample value/);
    assert.match(err({ ...base, body: 'Hi {{2}} and {{1}} ok' }), /in order/);
    assert.match(err({ ...base, body: '{{1}} is ready' }), /start or end/);
    assert.match(err({ ...base, buttons: [{ type: 'URL', text: 'A', url: 'https://a.com/{{1}}' }] }), /sample link/);
    assert.match(err({ ...base, buttons: [1, 2, 3].map(() => ({ type: 'PHONE_NUMBER', text: 'Call', phoneNumber: '+97145550101' })) }), /1 phone/);
    const spec = model.templateSpecSchema.parse({
      ...base,
      header: { format: 'TEXT', text: 'Order {{1}}', example: 'TC-1' },
      footer: 'TyresCart',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Thanks' },
        { type: 'URL', text: 'Track', url: 'https://tyrescart.ae/o/{{1}}', example: 'https://tyrescart.ae/o/TC-1' },
        { type: 'PHONE_NUMBER', text: 'Call us', phoneNumber: '+97145550101' },
      ],
    });
    assert.deepEqual(model.buildCreateComponents(spec), [
      { type: 'HEADER', format: 'TEXT', text: 'Order {{1}}', example: { header_text: ['TC-1'] } },
      { type: 'BODY', text: 'Hi {{1}}, order {{2}} is ready.', example: { body_text: [['Amir', 'TC-1']] } },
      { type: 'FOOTER', text: 'TyresCart' },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Thanks' },
          { type: 'URL', text: 'Track', url: 'https://tyrescart.ae/o/{{1}}', example: ['https://tyrescart.ae/o/TC-1'] },
          { type: 'PHONE_NUMBER', text: 'Call us', phone_number: '+97145550101' },
        ],
      },
    ]);
    const auth = model.templateSpecSchema.parse({ name: 'login_code', category: 'AUTHENTICATION', language: 'en', codeExpirationMinutes: 10 });
    assert.deepEqual(model.buildCreateComponents(auth), [
      { type: 'BODY', add_security_recommendation: true },
      { type: 'FOOTER', code_expiration_minutes: 10 },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }] },
    ]);
  });
});

describe('templates against a mock of Meta', () => {
  test('send with values (and a header image), manage templates as an admin; agents can only send', async () => {
    const reg = `mutation($i: RegisterInput!) { register(input: $i) { token user { id } workspace { id } } }`;
    const o = (await gql(reg, { i: { name: 'Owner', email: `e2e-tpl-o-${run}@example.com`, password: 'password123', workspaceName: `tpl-${run}` } })).register;
    const { token: join } = (await gql(`mutation { createJoinLink { token } }`, {}, o.token)).createJoinLink;
    const a = (await gql(reg, { i: { name: 'Agent', email: `e2e-tpl-a-${run}@example.com`, password: 'password123', joinToken: join } })).register;
    await prisma.whatsAppAccount.create({ data: { workspaceId: o.workspace.id, wabaId: `waba-t-${run}`, phoneNumberId: `pn-t-${run}`, displayPhone: '+1 555 000 2222', accessToken: 'mock-token' } });
    await gql(`mutation($i: SimulateIncomingInput) { simulateIncomingMessage(input: $i) }`, { i: { waId: '971505556666', name: 'Amir', body: 'hi' } }, o.token);
    const conv = await prisma.conversation.findFirstOrThrow({ where: { workspaceId: o.workspace.id } });
    const owner = { userId: o.user.id, workspaceId: o.workspace.id };
    const agent = { userId: a.user.id, workspaceId: o.workspace.id };

    // the chat list of templates: approved only
    const approved = await svc.approvedTemplates(agent);
    assert.deepEqual(approved.map((t) => t.name), ['carousel_x', 'hello_world', 'order_ready', 'promo']);
    assert.equal(approved.find((t) => t.name === 'hello_world')?.needsParameters, false);
    assert.equal(approved.find((t) => t.name === 'order_ready')?.needsParameters, true);

    // send order_ready with values and a JPEG header
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]);
    seen.length = 0;
    const values = { header: {}, body: { '1': 'Amir', '2': 'TC-1042' }, buttons: { '0': 'TC-1042' } };
    const sent = await svc.sendTemplateMessage(owner, { conversationId: conv.id, name: 'order_ready', values }, { bytes: jpeg, mime: 'image/jpeg' });
    assert.equal(sent.status, 'sent', String(sent.error));
    assert.equal(sent.type, 'image');
    assert.equal(sent.body, 'Hi Amir, your order TC-1042 is ready for fitting.\n\nTyresCart\n\n[Track order] [Thanks]');
    assert.ok(sent.mediaPath);
    const msg = JSON.parse(seen.find((r) => r.path.endsWith('/messages'))!.body.toString());
    assert.deepEqual(msg.template, {
      name: 'order_ready',
      language: { code: 'en' },
      components: [
        { type: 'header', parameters: [{ type: 'image', image: { id: 'media-123' } }] },
        { type: 'body', parameters: [{ type: 'text', text: 'Amir' }, { type: 'text', text: 'TC-1042' }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'TC-1042' }] },
      ],
    });
    // a plain template: no components (agents send in chats assigned to them, as for replies)
    await assert.rejects(svc.sendTemplateMessage(agent, { conversationId: conv.id, name: 'hello_world' }), /Assign this chat/);
    await gql(`mutation($c: ID!, $m: ID, $r: String) { assignConversation(conversationId: $c, memberId: $m, reason: $r) { id } }`, { c: conv.id, m: a.user.id, r: 'test' }, o.token);
    const hello = await svc.sendTemplateMessage(agent, { conversationId: conv.id, name: 'hello_world' });
    assert.equal(hello.type, 'template');
    assert.deepEqual(JSON.parse(seen.filter((r) => r.path.endsWith('/messages')).at(-1)!.body.toString()).template, { name: 'hello_world', language: { code: 'en_US' } });
    // refused before anything is sent: a missing value, a missing header file, an unsupported or unknown template
    await assert.rejects(svc.sendTemplateMessage(owner, { conversationId: conv.id, name: 'order_ready', values: { body: { '1': 'Amir' } } }, { bytes: jpeg, mime: 'image/jpeg' }), /Fill in/);
    await assert.rejects(svc.sendTemplateMessage(owner, { conversationId: conv.id, name: 'order_ready', values }), /JPEG and PNG|empty/);
    await assert.rejects(svc.sendTemplateMessage(owner, { conversationId: conv.id, name: 'carousel_x' }), /carousel/);
    await assert.rejects(svc.sendTemplateMessage(owner, { conversationId: conv.id, name: 'nope' }), /not an approved template/);

    // Settings → Templates: admins only
    await assert.rejects(svc.allTemplates(agent), /admins/i);
    const all = await svc.allTemplates(owner);
    assert.equal(all.find((t) => t.name === 'old_offer')?.status, 'REJECTED');
    const spec = { name: 'tyre_reminder', category: 'MARKETING', language: 'en', body: 'Hi {{1}}, time to check your tyres!', bodyExamples: ['Amir'], footer: 'TyresCart' };
    await assert.rejects(svc.createMessageTemplate(agent, spec), /admins/i);
    seen.length = 0;
    const created = await svc.createMessageTemplate(owner, spec);
    assert.deepEqual(created, { id: 'new_tpl_1', status: 'PENDING', category: 'MARKETING' });
    const posted = JSON.parse(seen.find((r) => r.method === 'POST' && r.path.endsWith('/message_templates'))!.body.toString());
    assert.equal(posted.name, 'tyre_reminder');
    assert.deepEqual(posted.components[0], { type: 'BODY', text: 'Hi {{1}}, time to check your tyres!', example: { body_text: [['Amir']] } });
    await assert.rejects(svc.createMessageTemplate(owner, { ...spec, name: 'meta_refuses' }), /already exists/);
    // a media header: the sample goes through the app's upload API, its handle into the template
    seen.length = 0;
    await svc.createMessageTemplate(owner, { ...spec, name: 'tyre_photo', header: { format: 'IMAGE' } }, { bytes: jpeg, mime: 'image/jpeg', name: 'tyre.jpg' });
    assert.ok(seen.some((r) => r.path.endsWith('/app-42/uploads') && r.query.get('file_type') === 'image/jpeg'));
    assert.equal(seen.find((r) => r.path.includes('upload:SESSION1'))!.headers.authorization, 'OAuth mock-token');
    const withHandle = JSON.parse(seen.find((r) => r.path.endsWith('/message_templates'))!.body.toString());
    assert.deepEqual(withHandle.components[0], { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['HANDLE-XYZ'] } });
    // edit (name and language stay), delete one language
    seen.length = 0;
    await svc.updateMessageTemplate(owner, 'tpl_rej', { ...spec, name: 'old_offer', body: 'Big sale for {{1}} this week', bodyExamples: ['Amir'] });
    assert.ok(seen.some((r) => r.method === 'POST' && r.path.endsWith('/tpl_rej')));
    await assert.rejects(svc.updateMessageTemplate(owner, 'tpl_rej', { ...spec, name: 'renamed' }), /can't be changed/);
    seen.length = 0;
    await svc.deleteMessageTemplate(owner, 'old_offer', 'tpl_rej');
    const del = seen.find((r) => r.method === 'DELETE')!;
    assert.deepEqual([del.query.get('name'), del.query.get('hsm_id')], ['old_offer', 'tpl_rej']);
  });
});
