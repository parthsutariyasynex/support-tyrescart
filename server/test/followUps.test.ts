// Follow-up after 24 hours (Simple automations): one Meta-approved template when a customer's last message is 24
// hours old, filled in from the contact. Runs in this process with WhatsApp (templates and sending) replaced by a
// mock; customers are generated per run. The API server must be running (API_URL) for sign-ups.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';

const HOUR = 3_600_000;
const run = Date.now();
const tag = run.toString(36);

// Mock Meta: this run's templates, and every message sent to it
const FOLLOW_UP_TEXT = 'Hello {{1}} {{2}} 👋, I just wanted to follow up regarding your earlier inquiry.';
let templates = [
  { id: 't1', name: `follow_up_${tag}`, language: 'en', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: FOLLOW_UP_TEXT }] },
  { id: 't2', name: `promo_${tag}`, language: 'en', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'New stock!' }] },
  { id: 't3', name: `waiting_${tag}`, language: 'en', status: 'PENDING', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}' }] },
  // Meta's sample: approved on every new number, never the follow-up
  { id: 't4', name: 'hello_world', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'HEADER', format: 'TEXT', text: 'Hello World' }, { type: 'BODY', text: 'Welcome and congratulations!!' }] },
];
const sent: any[] = [];
const failFor = new Set<string>();
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname.endsWith('/message_templates'))
      return json(200, { data: templates.filter((t) => url.searchParams.get('status') !== 'APPROVED' || t.status === 'APPROVED') });
    if (req.method === 'POST' && url.pathname.endsWith('/messages')) {
      const j = JSON.parse(body || '{}');
      if (failFor.has(j.to)) return json(400, { error: { message: 'mock: recipient not reachable' } });
      sent.push(j);
      return json(200, { messages: [{ id: `wamid.fu-${Date.now()}-${Math.random().toString(36).slice(2)}` }] });
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

let fu: typeof import('../src/services/followUps.js');
let auto: typeof import('../src/services/automations.js');
let model: typeof import('../src/services/templateModel.js');
let messages: typeof import('../src/messages.js');
let prisma: typeof import('../src/prisma.js')['prisma'];
before(async () => {
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
  process.env.GRAPH_API_BASE = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
  fu = await import('../src/services/followUps.js');
  auto = await import('../src/services/automations.js');
  model = await import('../src/services/templateModel.js');
  messages = await import('../src/messages.js');
  prisma = (await import('../src/prisma.js')).prisma;
});
after(async () => {
  mock.close();
  await prisma?.$disconnect();
});

describe('follow-up rules', () => {
  const known = ['contact.first_name', 'contact.last_name', 'contact.name', 'contact.company_name', 'company.name'];
  const t = (name: string, body: string, extra: object = {}, status = 'APPROVED') =>
    model.parseTemplate({ id: name, name, language: 'en', status, category: 'MARKETING', components: [{ type: 'BODY', text: body }], ...extra });
  let followUp: ReturnType<typeof t>;
  before(() => {
    followUp = t('follow_up_inquiry', FOLLOW_UP_TEXT); // the module is loaded by then
  });
  test('the follow-up is found by its name (follow_up or follow_up_…), never any other approved template', () => {
    assert.equal(fu.isFollowUpName('follow_up'), true);
    assert.equal(fu.isFollowUpName('follow_up_inquiry'), true);
    assert.equal(fu.isFollowUpName('followup'), false);
    assert.equal(fu.isFollowUpName('hello_world'), false);
    assert.equal(fu.isFollowUpName('my_follow_up'), false);
    const hello = model.parseTemplate(templates.find((x) => x.name === 'hello_world'));
    const picked = fu.pickFollowUpTemplate([hello, t('order_ready', 'Your order is ready'), followUp], known);
    assert.ok('template' in picked);
    assert.equal(picked.template.name, 'follow_up_inquiry');
    // none: nothing to send, and why
    const none = fu.pickFollowUpTemplate([hello, t('order_ready', 'Your order is ready')], known);
    assert.ok('problem' in none);
    assert.match(none.problem, /No approved template named follow_up or follow_up_…/);
    // several: the first by name that can be sent automatically (one with an image header is passed over)
    const image = t('follow_up_a', 'New stock!', { components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'New stock!' }] });
    const two = fu.pickFollowUpTemplate([followUp, image, t('follow_up_z', 'Hi {{1}}')], known);
    assert.ok('template' in two);
    assert.equal(two.template.name, 'follow_up_inquiry');
    assert.equal(two.others, 2);
    const onlyImage = fu.pickFollowUpTemplate([image], known);
    assert.ok('problem' in onlyImage && /image header/.test(onlyImage.problem));
  });
  test('variables fill themselves: {{1}} = first name, {{2}} = last name; named ones by the workspace\'s variables', () => {
    assert.deepEqual(fu.pickFollowUpTemplate([followUp], known), {
      template: followUp,
      vars: [
        { part: 'body', name: '1', key: 'contact.first_name' },
        { part: 'body', name: '2', key: 'contact.last_name' },
      ],
      others: 0,
    });
    const named = t('follow_up', 'Hi {{first_name}} from {{company_name}}', { parameter_format: 'NAMED' });
    const p = fu.pickFollowUpTemplate([named], known);
    assert.ok('vars' in p);
    assert.deepEqual(p.vars.map((v) => v.key), ['contact.first_name', 'contact.company_name']); // company_name: the contact's (one match)
    const three = fu.pickFollowUpTemplate([t('follow_up', 'Hi {{1}} {{2}} {{3}}')], known);
    assert.ok('problem' in three && /\{\{3\}\} isn't filled automatically/.test(three.problem));
    const unknown = fu.pickFollowUpTemplate([t('follow_up', 'Hi {{nickname}}', { parameter_format: 'NAMED' })], known);
    assert.ok('problem' in unknown && /\{\{nickname\}\} isn't a contact or company detail/.test(unknown.problem));
  });
  test('values come from the contact; an empty one is reported (WhatsApp refuses it)', () => {
    const p = fu.pickFollowUpTemplate([followUp], known);
    assert.ok('vars' in p);
    assert.deepEqual(fu.followUpValues(followUp, p.vars, { 'contact.first_name': 'Bina', 'contact.last_name': 'Shah' }), { values: { header: {}, body: { 1: 'Bina', 2: 'Shah' }, buttons: {} } });
    assert.deepEqual(fu.followUpValues(followUp, p.vars, { 'contact.first_name': 'Bina', 'contact.last_name': '' }), { missing: '{{2}} (contact.last_name)' });
  });
});

describe('follow-ups on real chats', () => {
  test('on by default; once per quiet spell, 24 hours after the customer last wrote; never old chats in bulk; skips closed, snoozed, deleted and active chats', async () => {
    const reg = `mutation($i: RegisterInput!) { register(input: $i) { token user { id } workspace { id } } }`;
    const o = (await gql(reg, { i: { name: `Owner ${tag}`, email: `e2e-fu-o-${run}@example.com`, password: 'password123', workspaceName: `Follow-ups ${tag}` } })).register;
    const ws = o.workspace.id;
    const owner = { userId: o.user.id, workspaceId: ws };
    await prisma.whatsAppAccount.create({ data: { workspaceId: ws, wabaId: `waba-fu-${run}`, phoneNumberId: `pn-fu-${run}`, displayPhone: `+1 555 ${String(run).slice(-7)}`, accessToken: 'mock-token' } });

    // generated customers; each one's last message is set to the time the scenario needs
    let n = 0;
    const T0 = Date.now();
    const chat = async (opts: { lastInboundAt: number; first?: string; last?: string }) => {
      n += 1;
      const waId = `9715${String(run).slice(-6)}${String(n).padStart(2, '0')}`;
      const first = opts.first ?? `Cust${tag}${n}`;
      await messages.saveIncoming(ws, { waId, name: `${first} ${opts.last ?? ''}`.trim(), type: 'text', body: 'Hi', waMessageId: `wamid.fu-in-${run}-${n}` });
      const c = await prisma.conversation.findFirstOrThrow({ where: { workspaceId: ws, contact: { waId } }, include: { contact: true } });
      await prisma.contact.update({ where: { id: c.contactId }, data: { firstName: first, lastName: opts.last ?? null } });
      await prisma.conversation.update({ where: { id: c.id }, data: { lastInboundAt: new Date(opts.lastInboundAt) } });
      return { id: c.id, waId, contactId: c.contactId, first, last: opts.last };
    };
    const followUps = (id: string) => prisma.message.findMany({ where: { conversationId: id, automation: 'follow_up' }, orderBy: { createdAt: 'asc' } });

    // defaults: on, nothing active while Simple automations is off; nothing to choose
    const s0 = await auto.getAutomationSettings(owner);
    assert.equal(s0.followUpEnabled, true);
    assert.equal(s0.followUpActiveSince, null);
    assert.equal('followUpTemplate' in s0 && (s0 as { followUpTemplate?: unknown }).followUpTemplate != null, false);

    // an old chat from before the follow-up was active (its 24 hours ran out two days ago)
    const old = await chat({ lastInboundAt: T0 - 72 * HOUR, last: 'Old' });
    assert.equal(await fu.sendFollowUps(new Date(T0 + 48 * HOUR), ws), 0, 'Simple automations is off');

    // the template the settings page shows: found by its name, live from Meta
    const status = await fu.followUpTemplateStatus(owner);
    assert.equal(status.template?.name, `follow_up_${tag}`);
    assert.deepEqual(status.template?.variables.map((v) => v.key), ['contact.first_name', 'contact.last_name']);
    assert.equal(status.problem, null);

    // Simple automations on: active from now
    let s = await auto.updateAutomationSettings(owner, { enabled: true });
    const since = s.followUpActiveSince!.getTime();
    assert.ok(since >= T0);

    const due = await chat({ lastInboundAt: since - 23 * HOUR, first: 'Bina', last: 'Shah' }); // 24 hours end in 1 hour
    const closed = await chat({ lastInboundAt: since - 23 * HOUR, last: 'Closed' });
    const snoozed = await chat({ lastInboundAt: since - 23 * HOUR, last: 'Snoozed' });
    const deleted = await chat({ lastInboundAt: since - 23 * HOUR, last: 'Deleted' });
    const active = await chat({ lastInboundAt: since - 23 * HOUR, last: 'Active' });
    const noLast = await chat({ lastInboundAt: since - 23 * HOUR, first: 'Hana' });
    const unreachable = await chat({ lastInboundAt: since - 23 * HOUR, last: 'Away' });
    await prisma.conversation.update({ where: { id: closed.id }, data: { status: 'closed' } });
    await prisma.conversation.update({ where: { id: snoozed.id }, data: { status: 'snoozed', snoozedUntil: new Date(since + 72 * HOUR) } });
    await prisma.contact.update({ where: { id: deleted.contactId }, data: { deletedAt: new Date() } });
    failFor.add(unreachable.waId);

    // before the 24 hours are up: nothing
    assert.equal(await fu.sendFollowUps(new Date(since + 30 * 60_000), ws), 0);
    // the "active" customer writes again before the 24 hours are up
    await prisma.conversation.update({ where: { id: active.id }, data: { lastInboundAt: new Date(since + 30 * 60_000) } });

    // 2 hours later: the due chat gets exactly one, with the customer's names
    const at = since + 2 * HOUR;
    const before = sent.length;
    await fu.sendFollowUps(new Date(at), ws);
    const mine = sent.slice(before);
    assert.deepEqual(
      mine.map((p) => p.to),
      [due.waId],
      'only the due chat (not old, closed, snoozed, deleted, active; no last name and unreachable fail instead)',
    );
    assert.equal(mine[0].type, 'template');
    assert.equal(mine[0].template.name, `follow_up_${tag}`);
    assert.deepEqual(mine[0].template.components, [{ type: 'body', parameters: [{ type: 'text', text: 'Bina' }, { type: 'text', text: 'Shah' }] }]);
    const [shown] = await followUps(due.id);
    assert.equal(shown.body, 'Hello Bina Shah 👋, I just wanted to follow up regarding your earlier inquiry.');
    assert.equal(shown.status, 'sent');
    assert.equal(shown.sentById, null);
    for (const c of [old, closed, snoozed, deleted, active]) assert.equal((await followUps(c.id)).length, 0);

    // no last name and no fallback: shown as failed with the reason, not retried
    const [missing] = await followUps(noLast.id);
    assert.equal(missing.status, 'failed');
    assert.match(missing.error ?? '', /No value for \{\{2\}\} \(contact\.last_name\)/);
    // WhatsApp refuses: failed with the reason, not retried
    const [refused] = await followUps(unreachable.id);
    assert.equal(refused.status, 'failed');
    assert.match(refused.error ?? '', /recipient not reachable/);

    // checking again: no duplicates
    const count = sent.length;
    await fu.sendFollowUps(new Date(at + HOUR), ws);
    await fu.sendFollowUps(new Date(at + 5 * HOUR), ws);
    assert.equal(sent.length, count);
    assert.equal((await followUps(due.id)).length, 1);
    assert.equal((await followUps(noLast.id)).length, 1);

    // nothing entered on the contact, only the WhatsApp profile name: both names come from it
    const aliceWa = `9717${String(run).slice(-8)}`;
    await messages.saveIncoming(ws, { waId: aliceWa, name: 'Alice Patel', type: 'text', body: 'Hi', waMessageId: `wamid.fu-in-${run}-alice` });
    const alice = await prisma.conversation.findFirstOrThrow({ where: { workspaceId: ws, contact: { waId: aliceWa } }, include: { contact: true } });
    assert.equal(alice.contact.firstName, null);
    assert.equal(alice.contact.lastName, null);
    await prisma.conversation.update({ where: { id: alice.id }, data: { lastInboundAt: new Date(since - 18 * HOUR) } });
    await fu.sendFollowUps(new Date(since + 7 * HOUR), ws);
    const [toAlice] = await followUps(alice.id);
    assert.equal(toAlice?.status, 'sent');
    assert.equal(toAlice?.body, 'Hello Alice Patel 👋, I just wanted to follow up regarding your earlier inquiry.');
    assert.deepEqual(sent.at(-1).template.components, [{ type: 'body', parameters: [{ type: 'text', text: 'Alice' }, { type: 'text', text: 'Patel' }] }]);

    // the customer writes again and goes quiet for 24 hours: one more
    await prisma.conversation.update({ where: { id: due.id }, data: { lastInboundAt: new Date(at + 6 * HOUR) } });
    await fu.sendFollowUps(new Date(at + 20 * HOUR), ws);
    assert.equal((await followUps(due.id)).length, 1, 'not before 24 hours');
    await fu.sendFollowUps(new Date(at + 31 * HOUR), ws);
    assert.equal((await followUps(due.id)).length, 2);

    // no approved follow_up template at Meta (hello_world and others are): nothing is sent, the reason is shown
    const late = await chat({ lastInboundAt: since - 10 * HOUR, last: 'Late' });
    templates = templates.map((t) => (t.name === `follow_up_${tag}` ? { ...t, status: 'PAUSED' } : t));
    assert.equal(await fu.sendFollowUps(new Date(since + 20 * HOUR), ws), 0);
    assert.equal((await followUps(late.id)).length, 0);
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: late.id } })).followUpSentAt, null, 'not claimed: sent once one is approved');
    const none = await fu.followUpTemplateStatus(owner);
    assert.equal(none.template, null);
    assert.match(none.problem ?? '', /No approved template named follow_up/);
    templates = templates.map((t) => (t.name === `follow_up_${tag}` ? { ...t, status: 'APPROVED' } : t));
    await fu.sendFollowUps(new Date(since + 20 * HOUR), ws);
    assert.equal((await followUps(late.id)).length, 1, 'approved again: the waiting chat gets it');
    assert.ok(sent.every((p) => p.template?.name !== 'hello_world'), 'hello_world is never sent');

    // switched off, then on again later: chats whose 24 hours ran out while it was off are not messaged
    await auto.updateAutomationSettings(owner, { enabled: false });
    assert.equal((await auto.getAutomationSettings(owner)).followUpActiveSince, null);
    const whileOff = await chat({ lastInboundAt: Date.now() - 25 * HOUR, last: 'WhileOff' }); // its 24 hours ran out while off
    assert.equal(await fu.sendFollowUps(new Date(), ws), 0);
    await auto.updateAutomationSettings(owner, { enabled: true });
    assert.equal(await fu.sendFollowUps(new Date(Date.now() + 2 * HOUR), ws), 0);
    assert.equal((await followUps(whileOff.id)).length, 0, 'its 24 hours ran out before it was switched on again');

    // the follow-up switch alone also stops it
    await auto.updateAutomationSettings(owner, { followUpEnabled: false });
    assert.equal((await auto.getAutomationSettings(owner)).followUpActiveSince, null);

    // on, but its start was never recorded (switched on before follow-ups existed): the first check starts it now
    // and sends nothing, so old chats are never messaged in bulk
    const waiting = await chat({ lastInboundAt: Date.now() - 30 * HOUR, last: 'Waiting' });
    await prisma.automationSettings.update({ where: { workspaceId: ws }, data: { followUpEnabled: true, followUpActiveSince: null } });
    const firstCheck = Date.now();
    assert.equal(await fu.sendFollowUps(new Date(firstCheck), ws), 0);
    const started = (await prisma.automationSettings.findUniqueOrThrow({ where: { workspaceId: ws } })).followUpActiveSince;
    assert.equal(started?.getTime(), firstCheck);
    await fu.sendFollowUps(new Date(firstCheck + 5 * 60_000), ws);
    assert.equal((await followUps(waiting.id)).length, 0);
    assert.ok((await auto.getAutomationSettings(owner)).lastFollowUpAt);
  });
});
