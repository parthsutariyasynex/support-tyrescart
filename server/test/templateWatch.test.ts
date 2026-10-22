// Watching the follow-up template's review at Meta: checks at growing intervals, retries on errors, waits longer
// when Meta says "too many calls", tells the workspace once when Meta decides, and stops. Meta is a mock here.
// The API server must be running (API_URL) for sign-ups.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

const MIN = 60_000;
const run = Date.now();
const tag = run.toString(36);

// Mock Meta: the number's templates (changed by the test), how many times they were listed, and failures on demand
let templates: any[] = [];
let lists = 0;
let failWith: { status: number; message: string } | null = null;
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname.endsWith('/message_templates')) {
      lists += 1;
      if (failWith) return json(failWith.status, { error: { message: failWith.message } });
      return json(200, { data: templates });
    }
    if (req.method === 'POST' && url.pathname.endsWith('/message_templates')) {
      const j = JSON.parse(body || '{}');
      templates.push({ id: `t-${templates.length}`, name: j.name, language: j.language, status: 'PENDING', category: j.category, components: j.components });
      return json(200, { id: `t-${templates.length}`, status: 'PENDING', category: j.category });
    }
    json(404, { error: { message: 'mock: unknown' } });
  });
});

const API = process.env.API_URL ?? 'http://localhost:5001';
async function gql(query: string, variables: object = {}, token?: string) {
  const res = await fetch(`${API}/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  const j = (await res.json()) as { data?: any; errors?: { message: string }[] };
  if (j.errors) throw new Error(j.errors[0].message);
  return j.data;
}

let watch: typeof import('../src/services/templateWatch.js');
let tpl: typeof import('../src/services/templates.js');
let prisma: typeof import('../src/prisma.js')['prisma'];
before(async () => {
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
  process.env.GRAPH_API_BASE = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
  watch = await import('../src/services/templateWatch.js');
  tpl = await import('../src/services/templates.js');
  prisma = (await import('../src/prisma.js')).prisma;
});
after(async () => {
  watch?.stopWatching();
  mock.close();
  await prisma?.$disconnect();
});

const body = (text: string) => [{ type: 'BODY', text }];

test('the follow-up template is watched until Meta decides: growing intervals, retries, one notice, then it stops', async () => {
  const reg = `mutation($i: RegisterInput!) { register(input: $i) { token user { id } workspace { id } } }`;
  const o = (await gql(reg, { i: { name: `Owner ${tag}`, email: `e2e-tw-o-${run}@example.com`, password: 'password123', workspaceName: `Template watch ${tag}` } })).register;
  const ws = o.workspace.id;
  const owner = { userId: o.user.id, workspaceId: ws };
  await prisma.whatsAppAccount.create({ data: { workspaceId: ws, wabaId: `waba-tw-${run}`, phoneNumberId: `pn-tw-${run}`, displayPhone: `+1 555 ${String(run).slice(-7)}`, accessToken: 'mock-token' } });
  const notices: { ws: string; e: any }[] = [];
  const notify = (w: string, e: any) => notices.push({ ws: w, e });

  // creating a template in Message templates: only a follow_up one is watched
  await tpl.createMessageTemplate(owner, { name: `order_ready_${tag}`, category: 'UTILITY', language: 'en', body: 'Your order is ready', bodyExamples: [], buttons: [] });
  assert.equal(watch.isWatching(ws), false);
  await tpl.createMessageTemplate(owner, { name: 'follow_up_inquiry', category: 'UTILITY', language: 'en', body: 'Hello {{1}} {{2}} 👋, I just wanted to follow up regarding your earlier inquiry.', bodyExamples: ['Alice', 'Patel'], buttons: [] });
  assert.equal(watch.isWatching(ws), true);
  const t0 = Date.now(); // the watch started a moment ago
  // Meta's sample changes status too: not a follow-up, never reported
  templates.push({ id: 'hw', name: 'hello_world', language: 'en_US', status: 'PENDING', category: 'UTILITY', components: body('Welcome') });

  // nothing before the first minute
  lists = 0;
  await watch.checkTemplateWatches(t0 + 30_000, notify);
  assert.equal(lists, 0);
  // 1 minute: still in review; next check 2 minutes later
  await watch.checkTemplateWatches(t0 + MIN, notify);
  assert.equal(lists, 1);
  await watch.checkTemplateWatches(t0 + 2 * MIN, notify);
  assert.equal(lists, 1, 'not due yet: the gap grew to 2 minutes');
  // Meta has trouble: retried later, gap growing
  failWith = { status: 500, message: 'mock: temporary failure' };
  await watch.checkTemplateWatches(t0 + 3 * MIN, notify);
  assert.equal(lists, 2);
  await watch.checkTemplateWatches(t0 + 6 * MIN, notify);
  assert.equal(lists, 2, 'after a failure the next try waits longer (4 minutes)');
  // Meta says "too many calls": wait the longest gap (15 minutes)
  failWith = { status: 400, message: '(#80008) There have been too many calls to this WhatsApp Business account' };
  await watch.checkTemplateWatches(t0 + 7 * MIN, notify);
  assert.equal(lists, 3);
  await watch.checkTemplateWatches(t0 + 21 * MIN, notify);
  assert.equal(lists, 3, 'rate limited: not before 15 minutes');
  failWith = null;

  // approved (and hello_world changed too): one notice, for the follow-up only; then watching stops
  templates = templates.map((t) => (t.name === 'follow_up_inquiry' || t.name === 'hello_world' ? { ...t, status: 'APPROVED' } : t));
  await watch.checkTemplateWatches(t0 + 22 * MIN, notify);
  assert.equal(lists, 4);
  assert.deepEqual(notices, [{ ws, e: { name: 'follow_up_inquiry', language: 'en', status: 'APPROVED', category: 'UTILITY', rejectedReason: null } }]);
  assert.equal(watch.isWatching(ws), false);
  await watch.checkTemplateWatches(t0 + 60 * MIN, notify);
  assert.equal(lists, 4, 'no more calls once decided');

  // an edit sends it back to review: watched again; a rejection is reported with Meta's reason
  watch.watchFollowUpTemplates(ws, {}, t0 + 61 * MIN);
  templates = templates.map((t) => (t.name === 'follow_up_inquiry' ? { ...t, status: 'PENDING' } : t));
  await watch.checkTemplateWatches(t0 + 62 * MIN, notify); // first look: status recorded, nothing to report
  templates = templates.map((t) => (t.name === 'follow_up_inquiry' ? { ...t, status: 'REJECTED', rejected_reason: 'INVALID_FORMAT' } : t));
  await watch.checkTemplateWatches(t0 + 64 * MIN, notify);
  assert.equal(notices.length, 2);
  assert.deepEqual(notices[1].e, { name: 'follow_up_inquiry', language: 'en', status: 'REJECTED', category: 'UTILITY', rejectedReason: 'INVALID_FORMAT' });
  assert.equal(watch.isWatching(ws), false);

  // still in review after 48 hours: no longer checked
  templates = templates.map((t) => (t.name === 'follow_up_inquiry' ? { ...t, status: 'PENDING' } : t));
  watch.watchFollowUpTemplates(ws, { 'follow_up_inquiry|en': 'PENDING' }, t0);
  const calls = lists;
  await watch.checkTemplateWatches(t0 + 49 * 60 * MIN, notify);
  assert.equal(lists, calls);
  assert.equal(watch.isWatching(ws), false);
});
