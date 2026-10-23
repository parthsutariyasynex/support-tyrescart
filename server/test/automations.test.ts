// Simple automations: working hours, reply variables, turn order, and the rules run for incoming messages (in this
// process, with WhatsApp replaced by a mock, so nothing is sent). The API server must be running (API_URL) for
// sign-ups.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';

const sent: { to: string; body: string }[] = [];
const failFor = new Set<string>(); // recipients the mock WhatsApp refuses (send failures)
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method === 'POST' && req.url?.endsWith('/messages')) {
      const j = JSON.parse(body || '{}');
      if (failFor.has(j.to)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'mock: recipient not reachable', code: 131026 } }));
      }
      sent.push({ to: j.to, body: j.text?.body ?? '' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ messages: [{ id: `wamid.auto-${Date.now()}-${Math.random().toString(36).slice(2)}` }] }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'mock: unknown' } }));
  });
});

const API = process.env.API_URL ?? 'http://localhost:5001';
const run = Date.now();
async function gql(query: string, variables: object = {}, token?: string) {
  const res = await fetch(`${API}/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  const j = (await res.json()) as { data?: any; errors?: { message: string }[] };
  if (j.errors) throw new Error(j.errors[0].message);
  return j.data;
}

let auto: typeof import('../src/services/automations.js');
let vars: typeof import('../src/services/variables.js');
let messages: typeof import('../src/messages.js');
let prisma: typeof import('../src/prisma.js')['prisma'];
before(async () => {
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
  process.env.GRAPH_API_BASE = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
  auto = await import('../src/services/automations.js');
  vars = await import('../src/services/variables.js');
  messages = await import('../src/messages.js');
  prisma = (await import('../src/prisma.js')).prisma;
});
after(async () => {
  mock.close();
  await prisma?.$disconnect();
});

describe('automation rules', () => {
  test('working hours in the workspace time zone', () => {
    const s = { workingDays: '1,2,3,4,5,6', workStart: '09:00', workEnd: '18:00' };
    // 2026-10-21 is a Wednesday; Dubai is UTC+4
    assert.equal(auto.withinWorkingHours(s, 'Asia/Dubai', new Date('2026-10-21T05:00:00Z')), true); // 09:00 Dubai
    assert.equal(auto.withinWorkingHours(s, 'Asia/Dubai', new Date('2026-10-21T04:59:00Z')), false); // 08:59
    assert.equal(auto.withinWorkingHours(s, 'Asia/Dubai', new Date('2026-10-21T13:59:00Z')), true); // 17:59
    assert.equal(auto.withinWorkingHours(s, 'Asia/Dubai', new Date('2026-10-21T14:00:00Z')), false); // 18:00
    assert.equal(auto.withinWorkingHours(s, 'Asia/Dubai', new Date('2026-10-25T08:00:00Z')), false); // Sunday
    assert.equal(auto.withinWorkingHours(s, 'Asia/Kolkata', new Date('2026-10-21T04:00:00Z')), true); // 09:30 India
    // each day its own hours: Saturday 10:00-14:00, Sunday all day; the other days use the shared hours
    const own = { workingDays: '0,1,6', workStart: '09:00', workEnd: '18:00', dayHours: JSON.stringify({ 6: '10:00-14:00', 0: '00:00-23:59' }) };
    assert.deepEqual(auto.workingHoursOf(own), [
      { day: 1, start: '09:00', end: '18:00' },
      { day: 6, start: '10:00', end: '14:00' },
      { day: 0, start: '00:00', end: '23:59' },
    ]);
    assert.equal(auto.withinWorkingHours(own, 'Asia/Dubai', new Date('2026-10-24T05:30:00Z')), false); // Saturday 09:30
    assert.equal(auto.withinWorkingHours(own, 'Asia/Dubai', new Date('2026-10-24T06:00:00Z')), true); // Saturday 10:00
    assert.equal(auto.withinWorkingHours(own, 'Asia/Dubai', new Date('2026-10-24T10:00:00Z')), false); // Saturday 14:00
    assert.equal(auto.withinWorkingHours(own, 'Asia/Dubai', new Date('2026-10-25T19:59:30Z')), true); // Sunday 23:59
    assert.equal(auto.withinWorkingHours(own, 'Asia/Dubai', new Date('2026-10-21T08:00:00Z')), false); // Wednesday: closed
  });
  test('first and last name: entered on the contact first, else from the WhatsApp profile name', () => {
    const n = vars.nameParts;
    assert.deepEqual(n({ name: 'Alice Patel' }), { first: 'Alice', last: 'Patel' });
    assert.deepEqual(n({ name: '  Maria   de la  Cruz ' }), { first: 'Maria', last: 'de la Cruz' }); // the rest, spaces tidied
    assert.deepEqual(n({ name: 'Alice' }), { first: 'Alice', last: '' }); // one word: no last name
    assert.deepEqual(n({ name: '   ' }), { first: 'there', last: '' });
    assert.deepEqual(n({ name: null }), { first: 'there', last: '' });
    // entered names always win, each on its own
    assert.deepEqual(n({ firstName: 'Ali', lastName: 'Khan', name: 'Alice Patel' }), { first: 'Ali', last: 'Khan' });
    assert.deepEqual(n({ firstName: 'Ali', lastName: null, name: 'Alice Patel' }), { first: 'Ali', last: 'Patel' });
    assert.deepEqual(n({ firstName: '', lastName: 'Khan', name: 'Alice Patel' }), { first: 'Alice', last: 'Khan' });
    assert.deepEqual(n({ firstName: '  ', lastName: '  ', name: 'Alice Patel' }), { first: 'Alice', last: 'Patel' }); // blank counts as empty
  });
  test('filling variables: full keys, short forms (when unique), unknown ones left out', () => {
    const values = { 'contact.first_name': 'Amir', 'contact.name': 'Amir Khan', 'company.name': 'TyresCart', 'contact.tyre_size': '17' };
    assert.equal(vars.fillVariables('Hi {{contact.first_name}}, thanks for messaging {{company.name}}!', values), 'Hi Amir, thanks for messaging TyresCart!');
    assert.equal(vars.fillVariables('Hi {{first_name}} How can I help you??', values), 'Hi Amir How can I help you??');
    assert.equal(vars.fillVariables('Size {{ tyre_size }} for {{contact.name}}', values), 'Size 17 for Amir Khan');
    assert.equal(vars.fillVariables('{{contact.name}} {{unknown.thing}}!', values), 'Amir Khan !');
    assert.equal(vars.resolveKey('name', ['contact.name', 'company.name']), null); // ambiguous: needs the full key
    assert.deepEqual(vars.variablesIn('Hi {{First_Name}} {{x}} {{first_name}}'), ['first_name', 'x']);
  });
  test('turn order skips people who are not eligible and wraps round', () => {
    assert.equal(auto.nextInTurn(['a', 'b', 'c'], new Set(['a', 'b', 'c']), null), 'a');
    assert.equal(auto.nextInTurn(['a', 'b', 'c'], new Set(['a', 'b', 'c']), 'a'), 'b');
    assert.equal(auto.nextInTurn(['a', 'b', 'c'], new Set(['a', 'b', 'c']), 'c'), 'a');
    assert.equal(auto.nextInTurn(['a', 'b', 'c'], new Set(['a', 'c']), 'a'), 'c');
    assert.equal(auto.nextInTurn(['a', 'b'], new Set(), null), null);
  });
});

describe('automations on incoming messages', () => {
  test('auto-reply once per cooldown (working hours vs outside), routing in turn, nothing when off; admins only', async () => {
    const reg = `mutation($i: RegisterInput!) { register(input: $i) { token user { id } workspace { id } } }`;
    const o = (await gql(reg, { i: { name: 'Owner', email: `e2e-auto-o-${run}@example.com`, password: 'password123', workspaceName: `TyresCart Auto ${run}` } })).register;
    const { token: join } = (await gql(`mutation { createJoinLink { token } }`, {}, o.token)).createJoinLink;
    const a1 = (await gql(reg, { i: { name: 'Agent One', email: `e2e-auto-a1-${run}@example.com`, password: 'password123', joinToken: join } })).register;
    const a2 = (await gql(reg, { i: { name: 'Agent Two', email: `e2e-auto-a2-${run}@example.com`, password: 'password123', joinToken: join } })).register;
    const ws = o.workspace.id;
    await prisma.whatsAppAccount.create({ data: { workspaceId: ws, wabaId: `waba-a-${run}`, phoneNumberId: `pn-a-${run}`, displayPhone: '+1 555 000 4444', accessToken: 'mock-token' } });
    const members = await prisma.member.findMany({ where: { workspaceId: ws, userId: { in: [a1.user.id, a2.user.id] } }, select: { id: true, userId: true } });
    const m1 = members.find((m) => m.userId === a1.user.id)!.id;
    const m2 = members.find((m) => m.userId === a2.user.id)!.id;
    const owner = { userId: o.user.id, workspaceId: ws };

    // off by default: nothing happens
    await messages.saveIncoming(ws, { waId: '971505558801', name: 'Amir Khan', type: 'text', body: 'Hi', waMessageId: `wamid.in-${run}-0` });
    assert.equal(sent.length, 0);

    await assert.rejects(auto.updateAutomationSettings({ userId: a1.user.id, workspaceId: ws }, { enabled: true }), /admins/i);
    await assert.rejects(auto.updateAutomationSettings(owner, { workStart: '18:00', workEnd: '09:00' }), /end after/);
    await assert.rejects(auto.updateAutomationSettings(owner, { replyInHoursEnabled: true, replyInHours: '' }), /Write the reply/);
    await assert.rejects(auto.updateAutomationSettings(owner, { routingEnabled: true, routingMemberIds: ['nope'] }), /active members/);
    await assert.rejects(auto.updateAutomationSettings(owner, { workingHours: [{ day: 6, start: '14:00', end: '10:00' }] }), /Saturday: working hours must end after they start/);
    const perDay = await auto.updateAutomationSettings(owner, { workingHours: [{ day: 6, start: '10:00', end: '14:00' }, { day: 1, start: '09:00', end: '17:00' }] });
    assert.deepEqual(auto.workingHoursOf(perDay), [
      { day: 1, start: '09:00', end: '17:00' },
      { day: 6, start: '10:00', end: '14:00' },
    ]);
    // every day, all day: always "working hours" (so the test doesn't depend on the clock)
    const s = await auto.updateAutomationSettings(owner, {
      enabled: true,
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      workStart: '00:00',
      workEnd: '23:59',
      replyInHoursEnabled: true,
      replyInHours: 'Hi {{contact.first_name}}, thanks for messaging {{company.name}}! How can we help?',
      replyOutHoursEnabled: true,
      replyOutHours: 'Hi {{contact.first_name}}, we are closed now and will reply in the morning.',
      cooldownHours: 24,
      routingEnabled: true,
      routingMemberIds: [m1, m2],
    });
    assert.equal(s.enabled, true);

    // a new customer: routed to Agent One, auto-reply sent once
    await messages.saveIncoming(ws, { waId: '971505558802', name: 'Bina Shah', type: 'text', body: 'Do you have 17 inch tyres?', waMessageId: `wamid.in-${run}-1` });
    const c1 = await prisma.conversation.findFirstOrThrow({ where: { workspaceId: ws, contact: { waId: '971505558802' } } });
    assert.equal(c1.assignedToId, m1);
    assert.deepEqual(sent.at(-1), { to: '971505558802', body: `Hi Bina, thanks for messaging TyresCart Auto ${run}! How can we help?` });
    const reply = await prisma.message.findFirstOrThrow({ where: { conversationId: c1.id, automation: 'auto_reply' } });
    assert.equal(reply.status, 'sent');
    assert.equal(reply.sentById, null);
    // the same customer again: no second reply (cooldown); still Agent One's
    const before = sent.length;
    await messages.saveIncoming(ws, { waId: '971505558802', name: 'Bina Shah', type: 'text', body: 'Hello?', waMessageId: `wamid.in-${run}-2` });
    assert.equal(sent.length, before);
    // the next new customer goes to Agent Two, then back to Agent One
    await messages.saveIncoming(ws, { waId: '971505558803', name: 'Chen', type: 'text', body: 'Hi', waMessageId: `wamid.in-${run}-3` });
    await messages.saveIncoming(ws, { waId: '971505558804', name: 'Dev', type: 'text', body: 'Hi', waMessageId: `wamid.in-${run}-4` });
    const owners = await prisma.conversation.findMany({ where: { workspaceId: ws, contact: { waId: { in: ['971505558803', '971505558804'] } } }, include: { contact: true } });
    assert.deepEqual(owners.sort((x, y) => x.contact.waId.localeCompare(y.contact.waId)).map((c) => c.assignedToId), [m2, m1]);
    // the assignment shows in history as done by the system, with its reason
    const rec = await prisma.assignmentRecord.findFirstOrThrow({ where: { conversationId: c1.id } });
    assert.equal(rec.reason, 'Simple automations: routing');

    // one specific teammate: every new chat goes to them; "leave unassigned": nobody gets it
    await assert.rejects(auto.updateAutomationSettings(owner, { routingMode: 'specific', routingMemberIds: [m1, m2] }), /Choose the teammate/);
    await auto.updateAutomationSettings(owner, { routingMode: 'specific', routingMemberIds: [m2] });
    await messages.saveIncoming(ws, { waId: '971505558810', name: 'Ivan', type: 'text', body: 'Hi', waMessageId: `wamid.in-${run}-10` });
    await messages.saveIncoming(ws, { waId: '971505558811', name: 'Jo', type: 'text', body: 'Hi', waMessageId: `wamid.in-${run}-11` });
    const fixed = await prisma.conversation.findMany({ where: { workspaceId: ws, contact: { waId: { in: ['971505558810', '971505558811'] } } } });
    assert.deepEqual(fixed.map((c) => c.assignedToId), [m2, m2]);
    await auto.updateAutomationSettings(owner, { routingMode: 'unassigned' });
    await messages.saveIncoming(ws, { waId: '971505558812', name: 'Kai', type: 'text', body: 'Hi', waMessageId: `wamid.in-${run}-12` });
    assert.equal((await prisma.conversation.findFirstOrThrow({ where: { workspaceId: ws, contact: { waId: '971505558812' } } })).assignedToId, null);
    await auto.updateAutomationSettings(owner, { routingMode: 'round_robin', routingMemberIds: [m1, m2] });

    // variables come from this workspace's data: renamed and custom properties, stage names, company details
    await prisma.contactPropertyDefault.upsert({ where: { workspaceId: ws }, update: { labels: JSON.stringify({ companyName: 'Garage name' }) }, create: { workspaceId: ws, order: '[]', hidden: '[]', labels: JSON.stringify({ companyName: 'Garage name' }) } });
    const size = await prisma.contactCustomProperty.create({ data: { workspaceId: ws, name: 'Tyre size', key: 'tyre_size', type: 'number' } });
    const list = (await auto.getAutomationSettings(owner)).variables;
    assert.ok(list.some((v) => v.key === 'contact.company_name' && v.label === 'Garage name'), JSON.stringify(list));
    assert.ok(list.some((v) => v.key === 'contact.tyre_size' && v.label === 'Tyre size'));
    assert.ok(['contact.first_name', 'contact.last_name', 'contact.name', 'contact.phone', 'company.name'].every((k) => list.some((v) => v.key === k))); // the original five
    await assert.rejects(auto.updateAutomationSettings(owner, { replyInHours: 'Hi {{contact.firstname}}' }), /Unknown variable \{\{contact.firstname\}\}/);
    await auto.updateAutomationSettings(owner, { replyInHours: 'Hi {{first_name}} How can I help you?? Stage: {{contact.lead_stage}}, size {{tyre_size}}, call {{company.phone}}. {{contact.email}}' });
    await prisma.contact.create({ data: { workspaceId: ws, waId: '971505558809', name: 'Hana Ali', leadStage: 'qualified' } });
    const hana = await prisma.contact.findFirstOrThrow({ where: { workspaceId: ws, waId: '971505558809' } });
    await prisma.contactCustomValue.create({ data: { contactId: hana.id, propertyId: size.id, value: '18' } });
    await messages.saveIncoming(ws, { waId: '971505558809', name: 'Hana Ali', type: 'text', body: 'Hi', waMessageId: `wamid.in-${run}-9` });
    assert.equal(sent.at(-1)?.body, 'Hi Hana How can I help you?? Stage: Qualified, size 18, call +1 555 000 4444.'); // no email on file: left empty
    await auto.updateAutomationSettings(owner, { replyInHours: 'Hi {{contact.first_name}}, thanks for messaging {{company.name}}! How can we help?' });

    // outside working hours: the other reply (hours that never match: Sunday 00:00-00:01 only)
    await auto.updateAutomationSettings(owner, { workingDays: [0], workStart: '00:00', workEnd: '00:01' });
    await messages.saveIncoming(ws, { waId: '971505558805', name: 'Eva', type: 'text', body: 'Open?', waMessageId: `wamid.in-${run}-5` });
    assert.equal(sent.at(-1)?.body, 'Hi Eva, we are closed now and will reply in the morning.');
    // only the out-of-hours reply on: nothing during hours (Monday-Saturday all day)
    await auto.updateAutomationSettings(owner, { workingDays: [0, 1, 2, 3, 4, 5, 6], workStart: '00:00', workEnd: '23:59', replyInHoursEnabled: false });
    const n = sent.length;
    await messages.saveIncoming(ws, { waId: '971505558806', name: 'Faiz', type: 'text', body: 'Hi', waMessageId: `wamid.in-${run}-6` });
    assert.equal(sent.length, n);
    // turned off: nothing at all
    await auto.updateAutomationSettings(owner, { enabled: false, replyInHoursEnabled: true });
    await messages.saveIncoming(ws, { waId: '971505558807', name: 'Gita', type: 'text', body: 'Hi', waMessageId: `wamid.in-${run}-7` });
    assert.equal(sent.length, n);
    const gita = await prisma.conversation.findFirstOrThrow({ where: { workspaceId: ws, contact: { waId: '971505558807' } } });
    assert.equal(gita.assignedToId, null);
    // the settings page shows the last automatic reply
    assert.ok((await auto.getAutomationSettings(owner)).lastAutoReplyAt);
  });
});

// The whole path a real customer message takes: Meta's webhook (signed like Meta signs it) → saved in the chat →
// simple automations → reply sent through the (mock) WhatsApp API. Customer details are generated per run.
describe('auto-reply through the webhook', () => {
  test('variables from the database, working hours, cooldown, closed chats and send failures', async () => {
    const express = (await import('express')).default;
    const { webhookRouter } = await import('../src/routes/webhook.js');
    const { env } = await import('../src/env.js');
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => ((req as any).rawBody = buf) }));
    app.use('/webhook', webhookRouter);
    const server = await new Promise<ReturnType<typeof app.listen>>((r) => {
      const srv = app.listen(0, '127.0.0.1', () => r(srv));
    });
    const hook = `http://127.0.0.1:${(server.address() as { port: number }).port}/webhook`;

    const reg = `mutation($i: RegisterInput!) { register(input: $i) { token user { id } workspace { id } } }`;
    const o = (await gql(reg, { i: { name: `Owner ${run}`, email: `e2e-hook-o-${run}@example.com`, password: 'password123', workspaceName: `Hook Shop ${run}` } })).register;
    const ws = o.workspace.id;
    const owner = { userId: o.user.id, workspaceId: ws };
    const phoneNumberId = `pn-hook-${run}`;
    const account = await prisma.whatsAppAccount.create({ data: { workspaceId: ws, wabaId: `waba-hook-${run}`, phoneNumberId, displayPhone: `+1 555 ${String(run).slice(-7)}`, accessToken: 'mock-token' } });
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: ws } });
    const tz = (await auto.getAutomationSettings(owner)).timeZone;

    // generated customers: unique numbers and names for this run
    let n = 0;
    const customer = () => {
      n += 1;
      return { waId: `9715${String(run).slice(-6)}${String(n).padStart(2, '0')}`, first: `Cust${run.toString(36)}${n}`, last: `Tester${n}` };
    };
    let seq = 0;
    const deliver = async (c: { waId: string; first?: string; last?: string }, text: string) => {
      const id = `wamid.hook-${run}-${++seq}`;
      const payload = {
        object: 'whatsapp_business_account',
        entry: [{ id: account.wabaId, changes: [{ field: 'messages', value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: phoneNumberId, display_phone_number: account.displayPhone },
          ...(c.first ? { contacts: [{ profile: { name: `${c.first} ${c.last}` }, wa_id: c.waId }] } : {}),
          messages: [{ from: c.waId, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
        } }] }],
      };
      const raw = JSON.stringify(payload);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (env.metaAppSecret) headers['x-hub-signature-256'] = 'sha256=' + createHmac('sha256', env.metaAppSecret).update(raw).digest('hex');
      const res = await fetch(hook, { method: 'POST', headers, body: raw });
      assert.equal(res.status, 200);
      // the webhook answers first and works after: wait until the incoming message and automations are done
      for (let i = 0; i < 100; i++) {
        const m = await prisma.message.findUnique({ where: { waMessageId: id } });
        if (m) {
          await new Promise((r) => setTimeout(r, 150));
          return prisma.conversation.findFirstOrThrow({ where: { workspaceId: ws, contact: { waId: c.waId } }, include: { contact: true } });
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('the webhook message was never saved');
    };
    const autoReplies = (conversationId: string) => prisma.message.findMany({ where: { conversationId, automation: 'auto_reply' }, orderBy: { createdAt: 'asc' } });

    // a bad signature is refused when a secret is configured (as on production)
    if (env.metaAppSecret) assert.equal((await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=bad' }, body: '{}' })).status, 401);

    // open all day, every day (so the result doesn't depend on the clock)
    await auto.updateAutomationSettings(owner, {
      enabled: true,
      workingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '23:59' })),
      replyInHoursEnabled: true,
      replyInHours: 'Hi {{contact.first_name}} ({{contact.name}}, {{contact.phone}}), {{company.name}} here. Call {{company.phone}}. {{contact.email}}',
      replyOutHoursEnabled: true,
      replyOutHours: 'Hi {{first_name}}, {{company.name}} is closed now.',
      cooldownHours: 24,
    });

    // 1. a customer writes: one reply, every variable filled from the database (an empty email stays empty)
    const a = customer();
    const convA = await deliver(a, 'Hello');
    const expected = (c: typeof convA) => `Hi ${c.contact.name!.split(' ')[0]} (${c.contact.name}, +${c.contact.waId}), ${workspace.name} here. Call ${account.displayPhone}.`;
    let replies = await autoReplies(convA.id);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].body, expected(convA));
    assert.equal(replies[0].status, 'sent');
    assert.ok(replies[0].waMessageId);
    assert.deepEqual(sent.at(-1), { to: a.waId, body: expected(convA) });
    // a value changed in the contact's details is used in the next reply (nothing cached)
    await prisma.contact.update({ where: { id: convA.contactId }, data: { email: `${a.first.toLowerCase()}@example.com` } });

    // 2. the same customer again within 24 hours: no second reply
    await deliver(a, 'Are you there?');
    assert.equal((await autoReplies(convA.id)).length, 1);
    // ...after 24 hours, one more (the cooldown runs from the last automatic reply)
    const last = (await prisma.conversation.findUniqueOrThrow({ where: { id: convA.id } })).lastAutoReplyAt!;
    // the customer writes again at that (simulated) time, as on a real webhook: inside their new 24-hour window
    const writesAt = async (at: Date) => {
      await prisma.conversation.update({ where: { id: convA.id }, data: { lastInboundAt: at } });
      await auto.runAutomations(ws, convA.id, at);
    };
    await writesAt(new Date(last.getTime() + 24 * 3_600_000 - 60_000));
    assert.equal((await autoReplies(convA.id)).length, 1, 'not before 24 hours');
    await writesAt(new Date(last.getTime() + 24 * 3_600_000 + 60_000));
    replies = await autoReplies(convA.id);
    assert.equal(replies.length, 2);
    assert.ok(replies[1].body.endsWith(` ${a.first.toLowerCase()}@example.com`));

    // 3. no name from WhatsApp: first name falls back to "there"
    const b = { waId: customer().waId };
    const convB = await deliver(b, 'Hi');
    const bodyB = (await autoReplies(convB.id))[0]?.body ?? '(no reply)';
    assert.ok(bodyB.startsWith(`Hi there (there, +${b.waId})`), bodyB); // {{contact.name}} falls back the same way

    // 4. a closed chat gets no automatic reply; its message is still saved
    const c = customer();
    const convC0 = await deliver(c, 'First');
    await prisma.conversation.update({ where: { id: convC0.id }, data: { status: 'closed', lastAutoReplyAt: null } });
    const before = sent.length;
    const convC = await deliver(c, 'After closing');
    assert.equal(convC.status, 'closed');
    assert.equal(sent.length, before);
    assert.equal((await autoReplies(convC.id)).length, 1); // only the one from before it was closed
    assert.ok(await prisma.message.findFirst({ where: { conversationId: convC.id, direction: 'in', body: 'After closing' } }));

    // 5. WhatsApp refuses the reply: the customer's message is kept, the reply is shown as failed with the reason,
    //    and it isn't retried on every following message (the cooldown applies to failed attempts too)
    const d = customer();
    failFor.add(d.waId);
    const convD = await deliver(d, 'Hi');
    replies = await autoReplies(convD.id);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].status, 'failed');
    assert.match(replies[0].error ?? '', /recipient not reachable/);
    assert.ok(await prisma.message.findFirst({ where: { conversationId: convD.id, direction: 'in' } }));
    await deliver(d, 'Hello again');
    assert.equal((await autoReplies(convD.id)).length, 1);
    failFor.delete(d.waId);

    // 6. outside working hours: the other reply (open only on a day that isn't today in the workspace's time zone)
    const today = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date()));
    await auto.updateAutomationSettings(owner, { workingHours: [{ day: (today + 3) % 7, start: '09:00', end: '18:00' }] });
    const e = customer();
    const convE = await deliver(e, 'Open?');
    assert.equal((await autoReplies(convE.id))[0].body, `Hi ${e.first}, ${workspace.name} is closed now.`);

    // 7. switched off: nothing at all
    await auto.updateAutomationSettings(owner, { enabled: false });
    const f = customer();
    const convF = await deliver(f, 'Hi');
    assert.equal((await autoReplies(convF.id)).length, 0);

    await new Promise<void>((r) => server.close(() => r()));
  });
});
