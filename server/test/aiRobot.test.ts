// AI Robot (services/aiRobot.ts): automatic replies in unassigned chats. Runs in-process against the local database with
// a fake AI (setAiForTests) and WhatsApp replaced by a mock (GRAPH_API_BASE), so nothing is sent anywhere.
// Run: npx tsx --test test/aiRobot.test.ts (or npm run test:e2e, which runs every test file)
// Time is simulated (runAiRobot(id, now)): the waits are long in real time (5 minutes, 2 minutes after the robot has
// started), so an API server running on the same database (its own robot check every 15 s) never finds these chats
// due while the tests run, and the scheduled timers here never fire during them.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';

// WhatsApp mock: every text message "sent", by recipient
const sent: { to: string; body: string }[] = [];
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method === 'POST' && req.url?.endsWith('/messages')) {
      const j = JSON.parse(body || '{}');
      sent.push({ to: j.to, body: j.text?.body ?? '' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ messages: [{ id: `wamid.robot-${Date.now()}-${Math.random().toString(36).slice(2)}` }] }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'mock: unknown' } }));
  });
});

const run = Date.now();
let robot: typeof import('../src/services/aiRobot.js');
let ai: typeof import('../src/services/ai.js');
let messages: typeof import('../src/messages.js');
let assign: typeof import('../src/services/assign.js');
let status: typeof import('../src/services/conversationStatus.js');
let prisma: typeof import('../src/prisma.js')['prisma'];
let tyrescart: typeof import('../src/services/tyrescart.js');

// Fake Tyrescart catalogue (GraphQL answers by query); catalogueDown makes every query fail
let catalogueDown = false;
let catalogueQueries: string[] = [];
let webAnswer = 'Summer tyres grip best above 7 °C.';
const product = (name: string, price: number, stock = true, off = 0) => ({
  sku: `SKU-${name.replace(/\W+/g, '-')}`,
  name,
  url_key: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  stock_status: stock ? 'IN_STOCK' : 'OUT_OF_STOCK',
  price_range: { minimum_price: { regular_price: { value: off ? Math.round(price / (1 - off / 100)) : price }, final_price: { value: price, currency: 'AED' }, discount: { percent_off: off } } },
});
const CATALOGUE = [
  product('Michelin 245/40 R18 97Y Primacy 4 2026', 1006, false),
  product('Michelin 245/40 R18 97Y Pilot Sport 5 2026', 1019),
  product('Matrax 245/40 R18 97W Camarga 2026', 377),
  product('Matrax 245/40 R18 97W Urcola+ 2026', 388),
  product('Michelin 245/40 R19 98Y Pilot Sport 5 2026', 1210),
  product('Seam 245/40 R18 97W Jupiter 2026', 299, false),
];
async function fakeCatalogue(query: string): Promise<unknown> {
  catalogueQueries.push(query);
  if (catalogueDown) throw new tyrescart.CatalogueError('The Tyrescart catalogue answered HTTP 503');
  if (query.includes('products(')) {
    const w = /width: \{ eq: "(\d+)"/.exec(query)?.[1];
    const h = /height: \{ eq: "(\d+)"/.exec(query)?.[1];
    const brand = /brand: \{ eq: "([^"]+)"/.exec(query)?.[1];
    const items = CATALOGUE.filter((p) => p.name.includes(`${w}/${h}`) && (!brand || p.name.startsWith(brand)));
    return { products: { total_count: items.length, items } };
  }
  if (query.includes('kleverVehicleMakes')) return { kleverVehicleMakes: { data: [{ name: 'Toyota', slug: 'toyota' }, { name: 'BMW', slug: 'bmw' }] } };
  if (query.includes('kleverVehicleModels')) return { kleverVehicleModels: { data: [{ name: 'Camry', slug: 'camry' }, { name: 'Corolla', slug: 'corolla' }, { name: 'Corolla Cross', slug: 'corolla-cross' }] } };
  if (query.includes('kleverVehicleYears')) return { kleverVehicleYears: { data: [{ name: '2021', slug: '2021' }, { name: '2022', slug: '2022' }] } };
  if (query.includes('kleverVehicleModifications'))
    return {
      kleverVehicleModifications: {
        data: [
          { name: '2.5 LE', trim: null, is_stock: true, front_wheel: { tire_full: '215/55 R17' }, rear_wheel: { tire_full: '215/55 R17' } },
          { name: '3.5 XSE', trim: null, is_stock: true, front_wheel: { tire_full: '235/40 R19' }, rear_wheel: { tire_full: '235/40 R19' } },
          { name: '2.5 SE', trim: null, is_stock: false, front_wheel: { tire_full: '215/55 R17' }, rear_wheel: { tire_full: '215/55 R17' } },
        ],
      },
    };
  return {};
}

let ws = '';
const people: Record<string, { userId: string; memberId: string }> = {};
const users: string[] = [];
const auth = (name: string) => ({ userId: people[name].userId, workspaceId: ws });

// The fake AI: answer() decides what it says next; asked keeps every request
let asked: { kind: string; content: string }[] = [];
// Phase 2: answer also gets the robot's tools (catalogue, web search) and may call them first, like the real AI
let answer: (content: string, tools?: import('../src/services/ai.js').RobotTools) => string | Promise<string> = () => '';
const json = (o: object) => JSON.stringify(o);
const reply = (text: string, confidence = 0.9) => json({ action: 'reply', reply: text, reason: 'test', language: 'en', confidence });

let seq = 0;
const number = (i: number) => `9715${String(run).slice(-6)}${String(i).padStart(2, '0')}`;
async function customerWrites(waId: string, body: string, name = 'Ahmed') {
  await messages.saveIncoming(ws, { waId, name, type: 'text', body, waMessageId: `wamid.in-${run}-${++seq}` });
  return (await prisma.conversation.findFirstOrThrow({ where: { workspaceId: ws, contact: { waId } } })).id;
}
const minutes = (n: number) => new Date(Date.now() + n * 60_000);
const GROUP_SECONDS = 120;
const afterGroup = () => new Date(Date.now() + (GROUP_SECONDS + 5) * 1000);
const sentTo = (waId: string) => sent.filter((s) => s.to === waId);
const conv = (id: string) => prisma.conversation.findUniqueOrThrow({ where: { id } });
const runs = (id: string) => prisma.aiRobotRun.findMany({ where: { conversationId: id }, orderBy: { id: 'asc' } });
const settle = () => new Promise((r) => setTimeout(r, 300));
const setRobot = (data: Record<string, unknown>) => robot.updateAiRobotSettings(auth('admin'), data);

before(async () => {
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
  process.env.GRAPH_API_BASE = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
  // The Tyrescart catalogue is a fake (fakeCatalogue): never the real site
  process.env.TYRESCART_GRAPHQL_URL = 'http://127.0.0.1:9/graphql';
  process.env.TYRESCART_SITE_URL = 'https://shop.example';
  robot = await import('../src/services/aiRobot.js');
  ai = await import('../src/services/ai.js');
  messages = await import('../src/messages.js');
  assign = await import('../src/services/assign.js');
  status = await import('../src/services/conversationStatus.js');
  prisma = (await import('../src/prisma.js')).prisma;
  ai.setAiForTests(async (kind, _system, content, tools) => {
    asked.push({ kind, content });
    if (kind === 'web') return webAnswer;
    return answer(content, tools);
  });
  tyrescart = await import('../src/services/tyrescart.js');
  tyrescart.setTyrescartForTests(fakeCatalogue);
  ws = (await prisma.workspace.create({ data: { name: `e2e-robot-${run}` } })).id;
  for (const [name, role] of [
    ['owner', 'owner'],
    ['admin', 'admin'],
    ['sup', 'supervisor'],
    ['agent', 'agent'],
  ] as const) {
    const u = await prisma.user.create({ data: { name: `Robot ${name}`, email: `e2e-robot-${name}-${run}@example.com`, passwordHash: 'x', members: { create: { role, workspaceId: ws } } }, include: { members: true } });
    users.push(u.id);
    people[name] = { userId: u.id, memberId: u.members[0].id };
  }
  await prisma.whatsAppAccount.create({ data: { workspaceId: ws, wabaId: `waba-robot-${run}`, phoneNumberId: `pn-robot-${run}`, accessToken: 'mock-token' } });
});

after(async () => {
  ai?.setAiForTests(null);
  tyrescart?.setTyrescartForTests(null);
  await settle();
  if (ws) await prisma.workspace.delete({ where: { id: ws } }).catch(() => {});
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } });
  mock.close();
  await prisma?.$disconnect();
});

beforeEach(async () => {
  asked = [];
  catalogueDown = false;
  catalogueQueries = [];
  tyrescart?.setTyrescartForTests(fakeCatalogue);
  answer = () => reply('Hi Ahmed! Which tyre size do you need, or which car is it for?');
  // Live, 5 minutes for the first reply, then replies after the grouping pause (long here: see the top of the file)
  await setRobot({ enabled: true, mode: 'live', firstReplyMins: 5, groupSeconds: GROUP_SECONDS, hoursRule: 'any', maxRepliesPerDay: 20, minConfidence: 0.7, handoverMessage: null, companyInfo: 'Payment: cash, card, Tabby.', bannedPhrases: null });
});

describe('settings: owners and admins only', () => {
  test('agents and supervisors cannot read or change them', async () => {
    for (const who of ['agent', 'sup']) {
      await assert.rejects(robot.updateAiRobotSettings(auth(who), { enabled: false }), /admin/i);
      await assert.rejects(robot.getAiRobotSettings(auth(who)), /admin/i);
    }
  });
  test('owner and admin can, with validation', async () => {
    const s = await robot.updateAiRobotSettings(auth('owner'), { firstReplyMins: 7 });
    assert.equal(s.firstReplyMins, 7);
    assert.equal((await robot.getAiRobotSettings(auth('admin'))).firstReplyMins, 7);
    await assert.rejects(setRobot({ firstReplyMins: 0 }), /at least 1 minute/);
    await assert.rejects(setRobot({ mode: 'sometimes' }), /draft or live/);
  });
});

describe('when it replies', () => {
  test('first reply only after 5 minutes without an answer, then instant replies', async () => {
    const waId = number(1);
    const id = await customerWrites(waId, 'Hi, I need new tyres');
    assert.equal(await robot.runAiRobot(id, minutes(1)), null, 'not due after 1 minute');
    assert.equal(sentTo(waId).length, 0);
    assert.equal((await robot.inspect(id)).state, 'waiting');

    assert.equal(await robot.runAiRobot(id, minutes(6)), 'reply');
    assert.equal(sentTo(waId).length, 1);
    const out = await prisma.message.findFirstOrThrow({ where: { conversationId: id, direction: 'out' } });
    assert.equal(out.automation, 'ai_robot');
    assert.equal(out.status, 'sent');
    assert.equal((await conv(id)).aiRobotState, 'active');
    assert.equal(await robot.runAiRobot(id, minutes(7)), null, 'the last message is ours: nothing to answer');

    // The customer answers: due after the grouping pause only, no new 5-minute wait
    answer = () => reply('Thanks! Is it the same size on all 4 wheels?');
    await customerWrites(waId, 'Toyota Corolla 2020');
    const due = await robot.inspect(id);
    assert.equal(due.state, 'active');
    const last = await prisma.message.findFirstOrThrow({ where: { conversationId: id, direction: 'in' }, orderBy: { createdAt: 'desc' } });
    assert.equal(due.dueAt!.getTime(), last.createdAt.getTime() + GROUP_SECONDS * 1000);
    assert.equal(await robot.runAiRobot(id, afterGroup()), 'reply');
    assert.equal(sentTo(waId).length, 2);
    assert.match(sentTo(waId)[1].body, /same size/);
    assert.equal((await runs(id)).filter((r) => r.action === 'reply').length, 2);
  });

  test('the 5 minutes count from the first unanswered message', async () => {
    const waId = number(2);
    const id = await customerWrites(waId, 'Hello');
    await prisma.message.updateMany({ where: { conversationId: id }, data: { createdAt: minutes(-4) } });
    await customerWrites(waId, 'Anyone there?');
    assert.equal(await robot.runAiRobot(id, minutes(1.5)), 'reply', '5 minutes after the first message, not the second');
  });

  test('a welcome auto-reply does not count as our side', async () => {
    const waId = number(3);
    const id = await customerWrites(waId, 'Hi');
    await prisma.message.create({ data: { conversationId: id, direction: 'out', type: 'text', body: 'Welcome to Tyrescart!', status: 'sent', automation: 'auto_reply' } });
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'reply');
  });

  test('two triggers at once send one reply', async () => {
    const waId = number(4);
    const id = await customerWrites(waId, 'Price?');
    const results = await Promise.all([robot.runAiRobot(id, minutes(6)), robot.runAiRobot(id, minutes(6)), robot.checkDueChats(minutes(6), ws)]);
    assert.equal(results.filter((r) => r === 'reply').length + (results[2] as number), 1);
    assert.equal(sentTo(waId).length, 1);
  });
});

describe('when it stays out', () => {
  test('a team member replied: the robot stops for good', async () => {
    const waId = number(10);
    const id = await customerWrites(waId, 'Hi');
    await prisma.message.create({ data: { conversationId: id, direction: 'out', type: 'text', body: 'Hello, how can I help?', status: 'sent', sentById: people.sup.userId } });
    await customerWrites(waId, 'I need 4 tyres');
    assert.equal(await robot.runAiRobot(id, minutes(10)), null);
    assert.equal(sentTo(waId).length, 0);
    const c = await conv(id);
    assert.equal(c.aiRobotState, 'stopped');
    assert.equal(c.aiRobotReason, 'team_replied');
  });

  test('a person replying after the robot started stops it too', async () => {
    const waId = number(11);
    const id = await customerWrites(waId, 'Hi');
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'reply');
    await prisma.message.create({ data: { conversationId: id, direction: 'out', type: 'text', body: 'Sara here, I will take it from here', status: 'sent', sentById: people.admin.userId } });
    await customerWrites(waId, 'Great, thanks');
    await settle();
    assert.equal(await robot.runAiRobot(id, minutes(10)), null);
    assert.equal(sentTo(waId).length, 1, 'only the first robot reply');
    assert.equal((await conv(id)).aiRobotState, 'stopped');
  });

  test('assigned chats: never, and unassigning does not restart it', async () => {
    const waId = number(12);
    const id = await customerWrites(waId, 'Hi');
    await assign.assignConversation(ws, id, people.agent.memberId, people.owner.userId);
    assert.equal(await robot.runAiRobot(id, minutes(6)), null);
    assert.equal((await conv(id)).aiRobotReason, 'assigned');
    await assign.assignConversation(ws, id, null, people.owner.userId);
    await customerWrites(waId, 'Hello?');
    assert.equal(await robot.runAiRobot(id, minutes(10)), null);
    assert.equal(sentTo(waId).length, 0);
  });

  test('closing and reopening starts a new robot session', async () => {
    const waId = number(13);
    const id = await customerWrites(waId, 'Hi');
    await prisma.message.create({ data: { conversationId: id, direction: 'out', type: 'text', body: 'Hi!', status: 'sent', sentById: people.sup.userId } });
    await customerWrites(waId, 'Thanks');
    await robot.runAiRobot(id, minutes(6));
    assert.equal((await conv(id)).aiRobotState, 'stopped');
    await status.closeConversation(auth('sup'), id);
    assert.equal((await conv(id)).aiRobotState, null);
    await status.reopenConversation(auth('sup'), id);
    await customerWrites(waId, 'Back again, need tyres');
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'reply');
  });

  test('Stop robot in the chat', async () => {
    const waId = number(14);
    const id = await customerWrites(waId, 'Hi');
    const s = await robot.stopAiRobotInChat(auth('agent'), id);
    assert.equal(s.state, 'stopped');
    assert.equal(await robot.runAiRobot(id, minutes(6)), null);
  });

  test('off: nothing happens', async () => {
    await setRobot({ enabled: false });
    const waId = number(15);
    const id = await customerWrites(waId, 'Hi');
    assert.equal(await robot.runAiRobot(id, minutes(6)), null);
    assert.equal((await robot.inspect(id)).state, 'off');
  });
});

describe('handover and safety checks', () => {
  test('the AI hands over: handover message once, then quiet', async () => {
    answer = () => json({ action: 'handover', reply: '', reason: 'Customer wants a discount', language: 'en', confidence: 0.9 });
    const waId = number(20);
    const id = await customerWrites(waId, 'Can I get a discount on 4 tyres?');
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'handover');
    assert.equal(sentTo(waId)[0].body, robot.DEFAULT_HANDOVER);
    assert.equal((await conv(id)).aiRobotState, 'handover');
    await customerWrites(waId, 'Hello?');
    await settle();
    assert.equal(await robot.runAiRobot(id, minutes(10)), null);
    assert.equal(sentTo(waId).length, 1);
  });

  test('an invented price is never sent', async () => {
    answer = () => reply('The Michelin Pilot Sport 4 is AED 950 per tyre.');
    const waId = number(21);
    const id = await customerWrites(waId, 'How much is the Michelin PS4 245/40 R18?');
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'handover');
    assert.doesNotMatch(sentTo(waId)[0].body, /950/);
    assert.match((await runs(id))[0].reason ?? '', /950/);
  });

  test('numbers from the chat are allowed', async () => {
    answer = () => reply('Got it, 245/40 R18. Is it the same size on all 4 wheels?');
    const waId = number(22);
    const id = await customerWrites(waId, 'I need 245/40 R18');
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'reply');
  });

  test('Arabic customer gets Arabic, or a handover', async () => {
    answer = () => reply('Hello! Which size do you need?');
    const waId = number(23);
    const id = await customerWrites(waId, 'مرحبا، أحتاج إطارات');
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'handover');
    assert.match((await runs(id))[0].reason ?? '', /Arabic/);
  });

  test('low confidence, markdown and banned phrases are blocked', async () => {
    assert.match(robot.checkReply({ action: 'reply', reply: 'Hi', reason: '', language: 'en', confidence: 0.3 }, { facts: '', customerWroteArabic: false, minConfidence: 0.7, bannedPhrases: null, previousRobotReply: null }) ?? '', /not sure/);
    assert.match(robot.checkReply({ action: 'reply', reply: '**Hi**', reason: '', language: 'en', confidence: 0.9 }, { facts: '', customerWroteArabic: false, minConfidence: 0.7, bannedPhrases: null, previousRobotReply: null }) ?? '', /markdown/);
    assert.match(robot.checkReply({ action: 'reply', reply: 'We guarantee it', reason: '', language: 'en', confidence: 0.9 }, { facts: '', customerWroteArabic: false, minConfidence: 0.7, bannedPhrases: 'guarantee\nfree', previousRobotReply: null }) ?? '', /banned/);
    assert.match(robot.checkReply({ action: 'reply', reply: 'Which size do you need?', reason: '', language: 'en', confidence: 0.9 }, { facts: '', customerWroteArabic: false, minConfidence: 0.7, bannedPhrases: null, previousRobotReply: 'Which size do you need?' }) ?? '', /repeats/);
    assert.equal(robot.checkReply({ action: 'reply', reply: 'Which size do you need?', reason: '', language: 'en', confidence: 0.9 }, { facts: '', customerWroteArabic: false, minConfidence: 0.7, bannedPhrases: null, previousRobotReply: null }), null);
  });

  test('an unreadable AI answer is asked again once', async () => {
    let calls = 0;
    answer = () => (++calls === 1 ? 'Sure! Here you go' : reply('Which car is it for?'));
    const waId = number(24);
    const id = await customerWrites(waId, 'Hi');
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'reply');
    assert.equal(calls, 2);
  });

  test('the AI service fails: nothing is sent', async () => {
    answer = () => {
      throw new Error('AI down');
    };
    const waId = number(25);
    const id = await customerWrites(waId, 'Hi');
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'failed');
    assert.equal(sentTo(waId).length, 0);
    assert.equal((await runs(id))[0].action, 'failed');
  });

  test('daily limit: then a handover', async () => {
    await setRobot({ maxRepliesPerDay: 1 });
    const waId = number(26);
    const id = await customerWrites(waId, 'Hi');
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'reply');
    await customerWrites(waId, 'More questions');
    assert.equal(await robot.runAiRobot(id, afterGroup()), 'handover');
    assert.equal((await runs(id))[1].action, 'handover');
    assert.equal((await robot.inspect(id)).label, 'Handed over: daily reply limit reached');
  });
});

describe('draft mode', () => {
  test('writes the reply into its history and sends nothing', async () => {
    await setRobot({ mode: 'draft' });
    const waId = number(30);
    const id = await customerWrites(waId, 'Hi');
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'draft');
    assert.equal(sentTo(waId).length, 0);
    const [r] = await runs(id);
    assert.equal(r.action, 'draft');
    assert.match(r.draft ?? '', /tyre size/);
    assert.equal(await robot.runAiRobot(id, minutes(7)), null, 'the same message is not drafted twice');
  });

  test('Test the robot (admins): nothing saved or sent', async () => {
    const waId = number(31);
    const id = await customerWrites(waId, 'Hi');
    await assert.rejects(robot.testAiRobot(auth('agent'), id), /admin/i);
    const t = await robot.testAiRobot(auth('admin'), id);
    assert.equal(t.action, 'reply');
    assert.equal(sentTo(waId).length, 0);
    assert.equal((await runs(id)).length, 0);
  });
});

describe('phase 2: Tyrescart catalogue and web search', () => {
  // The fake AI calls search_tyres like the real one would, then answers with what it got
  const search = async (tools: import('../src/services/ai.js').RobotTools | undefined, args: Record<string, unknown> = { width: 245, height: 40, rim: 18 }) => {
    assert.ok(tools, 'the AI gets tools');
    return JSON.parse(await tools.run('search_tyres', args));
  };

  test('search_tyres: exact size only, in stock first, cheapest first, prices for 2 and 4, links', async () => {
    const r = await tyrescart.searchTyres({ width: '245', height: 40, rim: 'R18' });
    assert.equal(r.size, '245/40 R18');
    assert.deepEqual(
      r.options.map((o) => o.name),
      ['Matrax 245/40 R18 97W Camarga 2026', 'Matrax 245/40 R18 97W Urcola+ 2026', 'Michelin 245/40 R18 97Y Pilot Sport 5 2026', 'Seam 245/40 R18 97W Jupiter 2026', 'Michelin 245/40 R18 97Y Primacy 4 2026'],
      'R19 left out; in stock (cheapest first) before out of stock',
    );
    const ps5 = r.options[2];
    assert.equal(ps5.price_per_tyre, 'AED 1,019');
    assert.equal(ps5.price_for_2, 'AED 2,038');
    assert.equal(ps5.price_for_4, 'AED 4,076');
    assert.equal(ps5.link, 'https://shop.example/en/michelin-245-40-r18-97y-pilot-sport-5-2026');
    assert.equal(r.options[3].in_stock, false);
    // Filters: budget and brand
    const cheap = await tyrescart.searchTyres({ width: 245, height: 40, rim: 18, max_price_per_tyre: 390 });
    assert.deepEqual(cheap.options.map((o) => o.price_per_tyre), ['AED 377', 'AED 388', 'AED 299']);
    const none = await tyrescart.searchTyres({ width: 245, height: 40, rim: 18, brand: 'Pirelli' });
    assert.equal(none.options.length, 0);
    assert.match(none.note ?? '', /No 245\/40 R18 tyres found from Pirelli/);
    await assert.rejects(tyrescart.searchTyres({ width: 245, height: 40, rim: null }), /width, height and rim/);
  });

  test('search results are cached for 5 minutes', async () => {
    await tyrescart.searchTyres({ width: 245, height: 40, rim: 18 });
    await tyrescart.searchTyres({ width: 245, height: 40, rim: 18 });
    assert.equal(catalogueQueries.length, 1);
  });

  test('find_tyre_size: asks for the year, then gives the sizes per trim', async () => {
    const r1 = await tyrescart.findTyreSize({ make: 'toyota', model: 'CAMRY' });
    assert.deepEqual(r1, { status: 'need_year', vehicle: 'Toyota Camry', years: ['2021', '2022'] });
    const r2 = await tyrescart.findTyreSize({ make: 'Toyota', model: 'Camry', year: 2022 });
    assert.equal(r2.status, 'found');
    if (r2.status !== 'found') return;
    assert.equal(r2.vehicle, 'Toyota Camry 2022');
    assert.deepEqual(r2.sizes.map((s) => s.front), ['215/55 R17', '235/40 R19'], 'one entry per size');
    assert.equal((await tyrescart.findTyreSize({ make: 'Toyota', model: 'Corol' })).status, 'need_model');
    assert.equal((await tyrescart.findTyreSize({ make: 'Lada', model: 'Niva' })).status, 'not_found');
    assert.equal((await tyrescart.findTyreSize({ make: 'Toyota', model: 'Camry', year: 1990 })).status, 'not_found');
  });

  test('a price from search_tyres is sent, with the link', async () => {
    answer = async (_c, tools) => {
      const r = await search(tools, { width: 245, height: 40, rim: 18, brand: 'Michelin' });
      const o = r.options.find((x: { in_stock: boolean }) => x.in_stock);
      return JSON.stringify({ action: 'reply', reply: `Hi Ahmed! The ${o.name} is ${o.price_per_tyre} per tyre, fully fitted, VAT included (${o.price_for_4} for 4). ${o.link} Shall the team book the fitting?`, reason: 'quoted', language: 'en', confidence: 0.9, sources: [`tyrescart:${o.id}`] });
    };
    const waId = number(40);
    const id = await customerWrites(waId, 'Price for Michelin 245/40 R18?');
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'reply');
    const [msg] = sentTo(waId);
    assert.match(msg.body, /AED 1,019 per tyre/);
    assert.match(msg.body, /AED 4,076 for 4/);
    assert.match(msg.body, /https:\/\/shop\.example\/en\/michelin-245-40-r18-97y-pilot-sport-5-2026/);
  });

  test('a price the catalogue did not return is never sent', async () => {
    answer = async (_c, tools) => {
      await search(tools);
      // 1,019 is real; "AED 3,999 for 4" is not (the AI did its own maths)
      return reply('The Michelin Pilot Sport 5 245/40 R18 is AED 1,019 per tyre, or AED 3,999 for 4, fully fitted.');
    };
    const waId = number(41);
    const id = await customerWrites(waId, 'Michelin 245/40 R18 for 4 tyres?');
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'handover');
    assert.doesNotMatch(sentTo(waId)[0].body, /3,999/);
    assert.match((await runs(id))[0].reason ?? '', /3999/);
  });

  test('prices without searching (from memory) are blocked', async () => {
    answer = () => reply('The Michelin Pilot Sport 5 245/40 R18 is AED 1,019 per tyre.');
    const waId = number(42);
    const id = await customerWrites(waId, 'Michelin 245/40 R18 price?');
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'handover');
  });

  test('a link that is not from the catalogue is blocked', async () => {
    answer = async (_c, tools) => {
      await search(tools);
      return reply('The Matrax 245/40 R18 97W Camarga 2026 is AED 377 per tyre, fully fitted: https://other-shop.example/matrax');
    };
    const waId = number(43);
    const id = await customerWrites(waId, 'Cheapest 245/40 R18?');
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'handover');
    assert.match((await runs(id))[0].reason ?? '', /link/);
  });

  test('catalogue down: the AI is told so and the chat is handed over', async () => {
    catalogueDown = true;
    let toolResult = '';
    answer = async (_c, tools) => {
      toolResult = await tools!.run('search_tyres', { width: 245, height: 40, rim: 18 });
      return JSON.stringify({ action: 'handover', reply: '', reason: 'catalogue unavailable', language: 'en', confidence: 0.9 });
    };
    const waId = number(44);
    const id = await customerWrites(waId, 'Price for 245/40 R18?');
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'handover');
    assert.match(toolResult, /catalogue failed.*503.*hand over/i);
    assert.match(sentTo(waId)[0].body, /passing your chat to our team/);
  });

  test('web search: general knowledge only, its numbers are not facts', async () => {
    webAnswer = 'Summer tyres are best above 7 °C; winter tyres below.';
    answer = async (_c, tools) => {
      const r = JSON.parse(await tools!.run('search_web', { question: 'summer vs all season in UAE' }));
      assert.match(r.answer, /Summer tyres/);
      return reply('Summer tyres suit the UAE best: they grip well in the heat. Shall I look up options in your size?');
    };
    const waId = number(45);
    const id = await customerWrites(waId, 'Summer or all-season tyres for Dubai?');
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'reply');
    assert.ok(asked.some((a) => a.kind === 'web'), 'the web search ran');
    // A number that only the web gave is not allowed
    const facts = 'Customer: summer or all season?';
    assert.match(robot.checkReply({ action: 'reply', reply: 'They last about 40000 km.', reason: '', language: 'en', confidence: 0.9, sources: [] }, { facts, customerWroteArabic: false, minConfidence: 0.7, bannedPhrases: null, previousRobotReply: null }) ?? '', /40000/);
  });

  test('web search off in settings: the AI does not get it', async () => {
    await setRobot({ webSearch: false });
    let names: string[] = [];
    answer = (_c, tools) => {
      names = tools?.list.map((x) => x.name) ?? [];
      return reply('Which tyre size do you need?');
    };
    const id = await customerWrites(number(46), 'Hi');
    await robot.runAiRobot(id, minutes(6));
    assert.deepEqual(names, ['search_tyres', 'find_tyre_size']);
    await setRobot({ webSearch: true });
  });

  test('the budget question may name its AED amounts', async () => {
    answer = () => reply('Got it, 245/40 R18 on all 4. What is your budget per tyre: under AED 250, AED 250-400, over AED 400 or no limit?');
    const id = await customerWrites(number(47), '245/40 R18, same on all 4');
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'reply');
  });

  test('the example size may be used when asking for the size', async () => {
    answer = () => reply('Hi! What tyre size do you need (e.g. 245/40 R18), or which car is it for?');
    const id = await customerWrites(number(49), 'Hi, I need new tyres');
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'reply');
  });

  test('fitment lookup fails: the AI is told to ask for the size on the tyre, not to hand over', async () => {
    catalogueDown = true;
    let toolResult = '';
    answer = async (_c, tools) => {
      toolResult = await tools!.run('find_tyre_size', { make: 'Toyota', model: 'Camry', year: 2022 });
      return reply('Please share the size printed on the side of your current tyres, for example 245/40 R18.');
    };
    const id = await customerWrites(number(50), 'Which tyres fit a Toyota Camry 2022?');
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'reply');
    assert.match(toolResult, /ask the customer for the size printed on the side/);
    assert.doesNotMatch(toolResult, /hand over/);
  });

  test('amounts in AED are read in every common form', () => {
    assert.deepEqual(robot.amountsOf('AED 1,019 or 2,038 AED, 377 dirhams, Dhs 99.50, 4076 درهم'), ['1019', '2038', '377', '99.5', '4076']);
  });

  test('Test the robot shows the tools it used', async () => {
    answer = async (_c, tools) => {
      await search(tools);
      return reply('The Matrax 245/40 R18 97W Camarga 2026 is AED 377 per tyre, fully fitted, VAT included.');
    };
    const id = await customerWrites(number(48), 'Cheapest 245/40 R18?');
    const t = await robot.testAiRobot(auth('admin'), id);
    assert.equal(t.action, 'reply');
    assert.equal(t.tools.length, 1);
    assert.match(t.tools[0], /^search_tyres\(.*\) → 245\/40 R18: 5 of 5$/);
  });
});

describe('phase 3: what the screens read', () => {
  test('the chat tab: status with a countdown time, history with what the robot looked up', async () => {
    const waId = number(60);
    const id = await customerWrites(waId, 'Cheapest 245/40 R18?');
    const before = await robot.aiRobotStatus(auth('agent'), id);
    assert.equal(before.state, 'waiting');
    assert.equal(before.label, 'Waiting: the robot replies if nobody from the team does');
    assert.ok(before.dueAt && before.dueAt > new Date(), 'a time to count down to');

    answer = async (_c, tools) => {
      await tools!.run('search_tyres', { width: 245, height: 40, rim: 18 });
      return reply('The Matrax 245/40 R18 97W Camarga 2026 is AED 377 per tyre, fully fitted, VAT included.');
    };
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'reply');
    const [run] = await robot.aiRobotRuns(auth('agent'), id);
    assert.equal(run.action, 'reply');
    assert.deepEqual(run.tools, ['search_tyres 245/40 R18: 5 of 5']);
  });

  test('the chat list knows which chats were handed over (Needs human)', async () => {
    answer = () => json({ action: 'handover', reply: '', reason: 'wants a discount', language: 'en', confidence: 0.9 });
    const id = await customerWrites(number(61), 'Can I get a discount?');
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'handover');
    assert.equal((await conv(id)).aiRobotState, 'handover');
  });

  test('Test the robot: chats to pick from, owners and admins only', async () => {
    const id = await customerWrites(number(62), 'Do you fit tyres on Fridays?');
    await assert.rejects(robot.aiRobotTestChats(auth('agent')), /admin/i);
    const list = await robot.aiRobotTestChats(auth('admin'));
    const mine = list.find((c) => c.conversationId === id);
    assert.ok(mine, 'the chat is listed');
    assert.equal(mine.lastCustomerMessage, 'Do you fit tyres on Fridays?');
    assert.equal(mine.assigned, false);
  });

  test('the settings say what this server can do', async () => {
    const s = await robot.getAiRobotSettings(auth('admin'));
    assert.equal(s.catalogueConfigured, true);
    assert.equal(s.webSearchAvailable, true);
  });
});

describe('taking an order before handing over', () => {
  test('the order summary is sent, then the chat is handed to the team with the order', async () => {
    answer = async (_c, tools) => {
      const r = JSON.parse(await tools!.run('search_tyres', { width: 245, height: 40, rim: 18, brand: 'Michelin' }));
      const o = r.options.find((x: { in_stock: boolean }) => x.in_stock);
      return JSON.stringify({
        action: 'order',
        reply: `Thanks! Your order: 4 x ${o.name}, ${o.price_for_4} for 4, fully fitted, VAT included, at our Al Quoz branch on Saturday at 10 am. Our team will confirm the booking and payment here shortly.`,
        reason: `ORDER: 4 x ${o.name}, ${o.price_for_4}, Al Quoz branch, Saturday 10 am`,
        language: 'en',
        confidence: 0.95,
      });
    };
    const waId = number(70);
    const id = await customerWrites(waId, '4 of the Pilot Sport 5 please, Al Quoz branch, Saturday 10 am');
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'order');
    assert.match(sentTo(waId)[0].body, /AED 4,076 for 4/);
    const c = await conv(id);
    assert.equal(c.aiRobotState, 'handover');
    assert.equal(c.aiRobotReason, 'order');
    assert.match((await robot.inspect(id)).label, /order details collected/);
    const [run] = await runs(id);
    assert.equal(run.action, 'order');
    assert.match(run.reason ?? '', /^ORDER: 4 x Michelin 245\/40 R18 97Y Pilot Sport 5 2026, AED 4,076/);
    // Quiet afterwards, like any handover: the team confirms
    await customerWrites(waId, 'Thanks!');
    assert.equal(await robot.runAiRobot(id, afterGroup()), null);
  });

  test('an order with an invented total is not sent', async () => {
    answer = async (_c, tools) => {
      await tools!.run('search_tyres', { width: 245, height: 40, rim: 18 });
      return JSON.stringify({ action: 'order', reply: 'Your order: 4 x Michelin Pilot Sport 5 245/40 R18, AED 3,999 for 4, fully fitted. The team will confirm shortly.', reason: 'ORDER', language: 'en', confidence: 0.95 });
    };
    const waId = number(71);
    const id = await customerWrites(waId, '4 Pilot Sport 5, Al Quoz, Saturday');
    assert.equal(await robot.runAiRobot(id, minutes(6)), 'handover');
    assert.doesNotMatch(sentTo(waId)[0].body, /3,999/);
  });

  test('the instructions ask for quantity, place and day before handing over', () => {
    const p = robot.systemPrompt({ catalogue: true, web: true });
    assert.match(p, /Taking an order/);
    assert.match(p, /How many tyres/);
    assert.match(p, /preferred day and time/);
    assert.doesNotMatch(robot.systemPrompt({ catalogue: false, web: false }), /Taking an order/, 'without the catalogue an order is handed over as before');
  });
});
