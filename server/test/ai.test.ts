// AI Assistant (services/ai.ts): AI Summary (owners, admins and supervisors; one saved row per chat, Regenerate
// rewrites it) and AI Reply (a suggestion for whoever may reply; nothing saved or sent). Runs in-process against the
// local database with a fake AI: nothing is sent to Anthropic. Run: npm run test:e2e (picks up test/*.test.ts)
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import { env } from '../src/env.js';
import { prisma } from '../src/prisma.js';
import { saveIncoming } from '../src/messages.js';
import {
  AI_RETRY_MS,
  SUMMARY_BATCH_CHARS,
  SUMMARY_SETTLE_MS,
  aiConfigured,
  conversationSummary,
  generateConversationSummary,
  setAiForTests,
  suggestReply,
  REPLY_CONTEXT_CHARS,
  type AiKind,
} from '../src/services/ai.js';
import { assignConversation } from '../src/services/assign.js';

const run = Date.now();
let ws = '';
let other = '';
let chat = '';
const people: Record<string, { userId: string; memberId: string }> = {};
const created: string[] = [];
const auth = (name: string, workspaceId = ws) => ({ userId: people[name].userId, workspaceId });
// The fake AI: what it was asked (content: the chat in <conversation>, plus <summary> when continuing), and a numbered
// answer each time
let asked: { kind: AiKind; system: string; content: string }[] = [];
const fakeAi = async (kind: AiKind, system: string, content: string) => {
  asked.push({ kind, system, content });
  return kind === 'summary' ? `Summary #${asked.length}: customer wants 205/55 R16 tyres` : `Reply #${asked.length}: Thanks, we will check the price for you.`;
};
const settle = () => new Promise((r) => setTimeout(r, 300)); // logs are written without awaiting
const waId = `97150${String(run).slice(-7)}`;

before(async () => {
  SUMMARY_SETTLE_MS.value = 0; // messages made by the tests count at once (the settle rule has its own test)
  ws = (await prisma.workspace.create({ data: { name: `e2e-ai-${run}` } })).id;
  other = (await prisma.workspace.create({ data: { name: `e2e-ai-other-${run}` } })).id;
  for (const [name, role, workspaceId] of [
    ['owner', 'owner', ws],
    ['admin', 'admin', ws],
    ['sup', 'supervisor', ws],
    ['agent', 'agent', ws],
    ['outsider', 'owner', other],
  ] as const) {
    const u = await prisma.user.create({ data: { name: `AI ${name}`, email: `e2e-ai-${name}-${run}@example.com`, passwordHash: 'x', members: { create: { role, workspaceId } } }, include: { members: true } });
    created.push(u.id);
    people[name] = { userId: u.id, memberId: u.members[0].id };
  }
  // A connected number, and a customer who just wrote (24-hour window open)
  await prisma.whatsAppAccount.create({ data: { workspaceId: ws, wabaId: `waba-ai-${run}`, phoneNumberId: `pn-ai-${run}`, accessToken: 'mock-token' } });
  await saveIncoming(ws, { waId, name: 'Asha', type: 'text', body: 'Hi, do you have 205/55 R16 tyres?', waMessageId: `wamid.ai-${run}-1` });
  chat = (await prisma.conversation.findFirstOrThrow({ where: { workspaceId: ws, contact: { waId } } })).id;
});
after(async () => {
  setAiForTests(null);
  await prisma.workspace.deleteMany({ where: { id: { in: [ws, other] } } });
  await prisma.user.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});
beforeEach(() => {
  asked = [];
  setAiForTests(fakeAi);
});

describe('off until ANTHROPIC_API_KEY is set', () => {
  test('not configured: aiConfigured false; generating and suggesting are refused and nothing is saved', async () => {
    setAiForTests(null);
    const saved = { anthropic: env.anthropicApiKey, openRouter: env.openRouterApiKey };
    Object.assign(env, { anthropicApiKey: '', openRouterApiKey: '' });
    try {
      assert.equal(aiConfigured(), false);
      await assert.rejects(generateConversationSummary(auth('owner'), chat), { code: 'AI_NOT_CONFIGURED' });
      await assert.rejects(suggestReply(auth('owner'), chat), { code: 'AI_NOT_CONFIGURED' });
      assert.equal(await prisma.conversationSummary.count({ where: { conversationId: chat } }), 0);
    } finally {
      Object.assign(env, { anthropicApiKey: saved.anthropic, openRouterApiKey: saved.openRouter });
    }
  });
});

describe('AI Summary', () => {
  test('owners, admins and supervisors only; agents, other workspaces and unknown chats are refused', async () => {
    await assert.rejects(generateConversationSummary(auth('agent'), chat), { code: 'FORBIDDEN' });
    await assert.rejects(conversationSummary(auth('agent'), chat), { code: 'FORBIDDEN' });
    await assert.rejects(generateConversationSummary(auth('outsider', other), chat), { code: 'NOT_FOUND' });
    await assert.rejects(generateConversationSummary(auth('owner'), 'no-such-chat'), { code: 'NOT_FOUND' });
    assert.equal(asked.length, 0, 'the AI is never asked when refused');
    assert.equal(await conversationSummary(auth('sup'), chat), null, 'none yet');
  });
  test('generate saves one row with every field; regenerate rewrites the same row (createdBy kept, updatedBy moves)', async () => {
    const first = await generateConversationSummary(auth('sup'), chat);
    const newest = await prisma.message.findFirstOrThrow({ where: { conversationId: chat }, orderBy: { createdAt: 'desc' } });
    assert.match(first.id, /^\d+$/, 'BigInt id, returned as text');
    assert.deepEqual(
      [first.conversationId, first.summary, first.lastMessageId, first.createdBy, first.updatedBy, first.createdByName, first.upToDate],
      [chat, 'Summary #1: customer wants 205/55 R16 tyres', newest.id, people.sup.userId, people.sup.userId, 'AI sup', true],
    );
    assert.ok(first.createdAt instanceof Date && first.updatedAt instanceof Date);
    assert.equal(first.addedMessages, 1);
    assert.equal(asked[0].content, '<conversation>\nCustomer: Hi, do you have 205/55 R16 tyres?\n</conversation>', 'first run: the chat, no <summary>');
    assert.doesNotMatch(asked[0].content, new RegExp(waId), "never the customer's number");

    // A new message arrives: the summary says it's behind until regenerated
    await saveIncoming(ws, { waId, type: 'text', body: 'For a Toyota Corolla please', waMessageId: `wamid.ai-${run}-2` });
    assert.equal((await conversationSummary(auth('admin'), chat))!.upToDate, false);

    const again = await generateConversationSummary(auth('admin'), chat);
    const newest2 = await prisma.message.findFirstOrThrow({ where: { conversationId: chat }, orderBy: { createdAt: 'desc' } });
    const rows = await prisma.conversationSummary.findMany({ where: { conversationId: chat } });
    assert.equal(rows.length, 1, 'still one row');
    assert.deepEqual(
      [again.id, again.summary, again.lastMessageId, again.createdBy, again.updatedBy, again.updatedByName, again.upToDate, again.addedMessages],
      [first.id, 'Summary #2: customer wants 205/55 R16 tyres', newest2.id, people.sup.userId, people.admin.userId, 'AI admin', true, 1],
    );
    assert.ok(again.updatedAt.getTime() >= first.updatedAt.getTime());
    assert.equal(again.createdAt.getTime(), first.createdAt.getTime());
    // Regenerate: the saved summary plus only the message after the checkpoint (the first one is not sent again)
    assert.match(asked[1].content, /<summary>\nSummary #1: customer wants 205\/55 R16 tyres\n<\/summary>/);
    assert.match(asked[1].content, /<conversation>\nCustomer: For a Toyota Corolla please\n<\/conversation>$/);
    assert.doesNotMatch(asked[1].content, /do you have 205\/55/);
  });
  test('no new messages: the AI is not asked and nothing changes', async () => {
    const before = await prisma.conversationSummary.findUniqueOrThrow({ where: { conversationId: chat } });
    const same = await generateConversationSummary(auth('owner'), chat);
    assert.equal(asked.length, 0);
    const after = await prisma.conversationSummary.findUniqueOrThrow({ where: { conversationId: chat } });
    assert.deepEqual([same.addedMessages, same.upToDate, same.summary], [0, true, before.summary]);
    assert.deepEqual(after, before, 'row untouched (updatedBy and updatedAt too)');
  });
  test('an AI failure saves nothing and keeps the checkpoint; the next run includes the same messages', async () => {
    await saveIncoming(ws, { waId, type: 'text', body: 'Michelin preferred', waMessageId: `wamid.ai-${run}-3` });
    setAiForTests(async () => {
      throw new Error('network down');
    });
    const before = await prisma.conversationSummary.findUniqueOrThrow({ where: { conversationId: chat } });
    await assert.rejects(generateConversationSummary(auth('owner'), chat), { code: 'AI_UNAVAILABLE' });
    assert.deepEqual(await prisma.conversationSummary.findUniqueOrThrow({ where: { conversationId: chat } }), before);
    setAiForTests(fakeAi);
    const done = await generateConversationSummary(auth('owner'), chat);
    assert.match(asked[0].content, /<conversation>\nCustomer: Michelin preferred\n<\/conversation>$/, 'the message the failed run missed');
    assert.equal(done.addedMessages, 1);
  });
});

describe('AI Summary: the whole chat, batches and the checkpoint', () => {
  let n = 0;
  // A chat of its own with `count` customer messages, a second apart and in the past (so all are "settled")
  const newChat = async (count: number) => {
    n++;
    const contact = await prisma.contact.create({ data: { workspaceId: ws, waId: `97155${String(run + n).slice(-7)}`, name: `Long ${n}` } });
    const conv = await prisma.conversation.create({ data: { workspaceId: ws, contactId: contact.id } });
    const start = Date.now() - (count + 10) * 1000;
    await prisma.message.createMany({
      data: Array.from({ length: count }, (_, i) => ({ conversationId: conv.id, direction: i % 3 ? 'in' : 'out', type: 'text', body: `Message ${String(i + 1).padStart(4, '0')} ${'x'.repeat(40)}`, status: 'sent', createdAt: new Date(start + i * 1000) })),
    });
    return conv.id;
  };
  const add = (conversationId: string, body: string, extra: Record<string, unknown> = {}) =>
    prisma.message.create({ data: { conversationId, direction: 'in', type: 'text', body, status: 'received', ...extra } });
  // The chat lines each request carried, and every line across all requests
  const linesOf = (content: string) => /<conversation>\n([\s\S]*)\n<\/conversation>$/.exec(content)![1].split('\n');
  const allLines = () => asked.flatMap((a) => linesOf(a.content));
  const expected = async (conversationId: string) =>
    (await prisma.message.findMany({ where: { conversationId, deletedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map((m) => `${m.direction === 'in' ? 'Customer' : 'Team'}: ${m.body}`);
  const batch = SUMMARY_BATCH_CHARS.value;
  after(() => {
    SUMMARY_BATCH_CHARS.value = batch;
    SUMMARY_SETTLE_MS.value = 0;
  });
  let long = '';

  test('a long chat (1,200 messages, past several pages): every message once, in order, in batches; checkpoint = the last', async () => {
    long = await newChat(1200);
    SUMMARY_BATCH_CHARS.value = 3000;
    const s = await generateConversationSummary(auth('owner'), long);
    assert.ok(asked.length > 20, `${asked.length} requests`);
    assert.deepEqual(allLines(), await expected(long), 'all 1,200 lines, each once, in order');
    for (const [i, a] of asked.entries()) {
      assert.ok(linesOf(a.content).join('\n').length <= 3000, `batch ${i + 1} within the batch size`);
      // Each batch after the first continues the summary so far
      if (i === 0) assert.doesNotMatch(a.content, /<summary>/);
      else assert.match(a.content, new RegExp(`<summary>\\nSummary #${i}: `));
    }
    const lastMessage = await prisma.message.findFirstOrThrow({ where: { conversationId: long }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    assert.deepEqual([s.lastMessageId, s.summary, s.addedMessages, s.upToDate], [lastMessage.id, `Summary #${asked.length}: customer wants 205/55 R16 tyres`, 1200, true]);
  });
  test('Regenerate after more messages: one request with the saved summary and only the new ones', async () => {
    const saved = await prisma.conversationSummary.findUniqueOrThrow({ where: { conversationId: long } });
    const fresh = [await add(long, 'Is it still in stock?'), await add(long, 'Can you deliver to Sharjah?')];
    const s = await generateConversationSummary(auth('sup'), long);
    assert.equal(asked.length, 1);
    assert.match(asked[0].content, new RegExp(`^The <summary> is your summary[\\s\\S]*<summary>\\n${saved.summary.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\n</summary>`));
    assert.deepEqual(linesOf(asked[0].content), ['Customer: Is it still in stock?', 'Customer: Can you deliver to Sharjah?']);
    assert.deepEqual([s.lastMessageId, s.addedMessages, s.upToDate, s.summary], [fresh[1].id, 2, true, 'Summary #1: customer wants 205/55 R16 tyres']);
  });
  test('a failure in the middle of a long first run saves nothing; the next run starts from the first message again', async () => {
    const chatId = await newChat(200);
    SUMMARY_BATCH_CHARS.value = 2000;
    let calls = 0;
    setAiForTests(async (kind, system, content) => {
      if (++calls === 3) throw new Error('provider down');
      return fakeAi(kind, system, content);
    });
    await assert.rejects(generateConversationSummary(auth('owner'), chatId), { code: 'AI_UNAVAILABLE' });
    assert.equal(await prisma.conversationSummary.count({ where: { conversationId: chatId } }), 0, 'no partial summary or checkpoint');
    asked = [];
    setAiForTests(fakeAi);
    const s = await generateConversationSummary(auth('owner'), chatId);
    assert.deepEqual(allLines(), await expected(chatId), 'all 200 again, from the first');
    assert.equal(s.addedMessages, 200);
  });
  test('a failure during Regenerate keeps the old summary and checkpoint; nothing is skipped next time', async () => {
    const saved = await prisma.conversationSummary.findUniqueOrThrow({ where: { conversationId: long } });
    await add(long, 'Price for 4 please');
    setAiForTests(async () => {
      throw new Error('busy');
    });
    await assert.rejects(generateConversationSummary(auth('owner'), long));
    assert.deepEqual(await prisma.conversationSummary.findUniqueOrThrow({ where: { conversationId: long } }), saved);
    setAiForTests(fakeAi);
    await generateConversationSummary(auth('owner'), long);
    assert.deepEqual(linesOf(asked[0].content), ['Customer: Price for 4 please']);
  });
  test('two Generate clicks at once share one run: one AI request, one row, the same answer', async () => {
    await add(long, 'Hello?');
    const [a, b] = await Promise.all([generateConversationSummary(auth('owner'), long), generateConversationSummary(auth('sup'), long)]);
    assert.equal(asked.length, 1);
    assert.deepEqual([a.summary, a.lastMessageId], [b.summary, b.lastMessageId]);
    assert.equal(await prisma.conversationSummary.count({ where: { conversationId: long } }), 1);
  });
  test('saved by someone else meanwhile (e.g. another server): theirs is kept, not overwritten with an older view', async () => {
    await add(long, 'Any update?');
    setAiForTests(async (kind, system, content) => {
      const text = await fakeAi(kind, system, content);
      await prisma.conversationSummary.update({ where: { conversationId: long }, data: { summary: 'Saved by another server' } });
      return text;
    });
    const s = await generateConversationSummary(auth('owner'), long);
    assert.deepEqual([s.summary, s.addedMessages], ['Saved by another server', 0]);
    assert.equal((await prisma.conversationSummary.findUniqueOrThrow({ where: { conversationId: long } })).summary, 'Saved by another server');
  });
  test('deleted messages are never sent, but the checkpoint moves past them (no AI request when that is all)', async () => {
    await generateConversationSummary(auth('owner'), long); // catch up ("Any update?" was left by the previous test)
    asked = [];
    const gone = await add(long, 'Deleted for everyone', { deletedAt: new Date() });
    const before = await prisma.conversationSummary.findUniqueOrThrow({ where: { conversationId: long } });
    const s = await generateConversationSummary(auth('owner'), long);
    assert.equal(asked.length, 0);
    assert.deepEqual([s.lastMessageId, s.summary, s.addedMessages, s.upToDate], [gone.id, before.summary, 0, true]);
  });
  test('messages from the last moments wait for the next run (never left behind the checkpoint)', async () => {
    SUMMARY_SETTLE_MS.value = 60_000;
    await add(long, 'Just now');
    const s = await generateConversationSummary(auth('owner'), long);
    assert.deepEqual([asked.length, s.addedMessages, s.upToDate], [0, 0, false]);
    SUMMARY_SETTLE_MS.value = 0;
    await generateConversationSummary(auth('owner'), long);
    assert.deepEqual(linesOf(asked[0].content), ['Customer: Just now']);
  });
  test('a checkpoint that no longer exists: starts over from the first message, without the old summary', async () => {
    await prisma.conversationSummary.update({ where: { conversationId: long }, data: { lastMessageId: 'no-such-message' } });
    SUMMARY_BATCH_CHARS.value = 1_000_000;
    const s = await generateConversationSummary(auth('owner'), long);
    assert.equal(asked.length, 1);
    assert.doesNotMatch(asked[0].content, /<summary>/);
    assert.deepEqual(linesOf(asked[0].content), await expected(long));
    assert.equal(s.upToDate, true);
  });
});

describe('through OpenRouter (mock)', () => {
  // A local stand-in for OpenRouter's chat completions: records each request, answers with `reply`
  let reply: { status: number; body: unknown } = { status: 200, body: {} };
  // Answers used first, one per request, before falling back to `reply`
  let queue: { status: number; body: unknown }[] = [];
  const requests: { auth: string | undefined; body: any }[] = [];
  const mock = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      const answer = queue.shift() ?? reply;
      res.writeHead(answer.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  const saved = { key: env.openRouterApiKey, base: env.openRouterBase, model: env.aiModel };
  before(async () => {
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
    Object.assign(env, { openRouterApiKey: 'sk-or-test-key', openRouterBase: `http://127.0.0.1:${(mock.address() as AddressInfo).port}`, aiModel: 'google/gemma-4-26b-a4b-it:free' });
  });
  after(() => {
    Object.assign(env, { openRouterApiKey: saved.key, openRouterBase: saved.base, aiModel: saved.model });
    mock.close();
  });
  beforeEach(() => {
    setAiForTests(null);
    requests.length = 0;
    queue = [];
    AI_RETRY_MS.value = 0;
  });
  test('sends the model, the key and the chat (instructions in the user message, no number); returns the text', async () => {
    reply = { status: 200, body: { choices: [{ message: { content: '  Hi! Which brand do you prefer?  ' } }] } };
    assert.equal(await suggestReply(auth('owner'), chat), 'Hi! Which brand do you prefer?');
    const [r] = requests;
    assert.equal(r.auth, 'Bearer sk-or-test-key');
    assert.equal(r.body.model, 'google/gemma-4-26b-a4b-it:free');
    assert.deepEqual(r.body.messages.map((m: { role: string }) => m.role), ['user']);
    assert.match(r.body.messages[0].content, /You draft the next WhatsApp reply[\s\S]*<conversation>\nCustomer: Hi, do you have 205\/55 R16 tyres\?/);
    assert.doesNotMatch(JSON.stringify(r.body), new RegExp(waId));
  });
  test('briefly busy or unavailable (429, 502 in the body): tried once more, and the second answer is used', async () => {
    queue = [{ status: 429, body: { error: { code: 429 } } }];
    reply = { status: 200, body: { choices: [{ message: { content: 'Second try worked' } }] } };
    assert.equal(await suggestReply(auth('owner'), chat), 'Second try worked');
    queue = [{ status: 200, body: { error: { message: 'Upstream error from Nvidia: ResourceExhausted', code: 502 } } }];
    assert.equal(await suggestReply(auth('owner'), chat), 'Second try worked');
    assert.equal(requests.length, 4, 'two requests each');
    // Other failures (e.g. a bad key) are not retried
    requests.length = 0;
    reply = { status: 401, body: { error: { message: 'User not found.', code: 401 } } };
    await assert.rejects(suggestReply(auth('owner'), chat), { code: 'AI_UNAVAILABLE' });
    assert.equal(requests.length, 1);
  });
  test('rate-limited (429): "busy", nothing saved; an empty answer is an error too', async () => {
    reply = { status: 429, body: { error: { message: 'temporarily rate-limited upstream', code: 429 } } };
    await saveIncoming(ws, { waId, type: 'text', body: 'Still there?', waMessageId: `wamid.ai-${run}-busy` }); // something new to summarize
    const before = await prisma.conversationSummary.findUniqueOrThrow({ where: { conversationId: chat } });
    await assert.rejects(generateConversationSummary(auth('owner'), chat), { code: 'AI_BUSY' });
    assert.deepEqual(await prisma.conversationSummary.findUniqueOrThrow({ where: { conversationId: chat } }), before, 'summary and checkpoint unchanged');
    reply = { status: 200, body: { choices: [{ message: { content: '' } }] } };
    await assert.rejects(suggestReply(auth('owner'), chat), { code: 'AI_UNAVAILABLE' });
    // A provider's failure sent as HTTP 200 with an error body
    reply = { status: 200, body: { error: { message: 'Upstream error: ResourceExhausted', code: 502 } } };
    await assert.rejects(suggestReply(auth('owner'), chat), { code: 'AI_UNAVAILABLE', message: "Couldn't reach the AI. Try again." });
    reply = { status: 200, body: { error: { message: 'rate-limited', code: 429 } } };
    await assert.rejects(suggestReply(auth('owner'), chat), { code: 'AI_BUSY' });
  });
});

describe('AI Reply', () => {
  test('a suggestion only: nothing is saved or sent, and the logs hold no text', async () => {
    const messagesBefore = await prisma.message.count({ where: { conversationId: chat } });
    const reply = await suggestReply(auth('owner'), chat);
    assert.equal(reply, 'Reply #1: Thanks, we will check the price for you.');
    assert.equal(asked[0].kind, 'reply');
    assert.equal(await prisma.message.count({ where: { conversationId: chat } }), messagesBefore, 'no message created');
    await settle();
    const logs = await prisma.logEntry.findMany({ where: { workspaceId: ws, event: { startsWith: 'ai.' } } });
    assert.ok(logs.some((l) => l.event === 'ai.reply') && logs.some((l) => l.event === 'ai.summary'));
    assert.doesNotMatch(JSON.stringify(logs), /Thanks, we will check|205\/55|Toyota Corolla|Summary #/);
  });
  // A chat of its own (24-hour window open) with these messages, a second apart and in the past
  let k = 0;
  const chatWith = async (messages: { direction: 'in' | 'out'; body: string; deletedAt?: Date }[]) => {
    k++;
    const contact = await prisma.contact.create({ data: { workspaceId: ws, waId: `97156${String(run + k).slice(-7)}`, name: `Reply ${k}` } });
    const conv = await prisma.conversation.create({ data: { workspaceId: ws, contactId: contact.id, lastInboundAt: new Date() } });
    const start = Date.now() - (messages.length + 10) * 1000;
    await prisma.message.createMany({ data: messages.map((m, i) => ({ conversationId: conv.id, type: 'text', status: 'sent', createdAt: new Date(start + i * 1000), ...m })) });
    return conv.id;
  };
  const block = (content: string, tag: string) => new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(content)?.[1];
  const label = (n: number) => `Message ${String(n).padStart(3, '0')}`;

  test("a 300-message chat: one request answering the customer's latest message, with only the chat around it (no 60 limit, never the whole chat)", async () => {
    // Odd messages from the customer, even ones from the team; the newest (300) is the team's, so 299 is the target
    const body = (n: number) => `${label(n)} ${'x'.repeat(50)}`;
    const id = await chatWith(Array.from({ length: 300 }, (_, i) => ({ direction: (i + 1) % 2 ? 'in' : 'out', body: body(i + 1) })));
    await suggestReply(auth('owner'), id);
    assert.equal(asked.length, 1);
    const [{ kind, system, content }] = asked;
    assert.equal(kind, 'reply');
    assert.equal(block(content, 'latest_customer_message'), `Customer: ${body(299)}`);
    const context = block(content, 'conversation')!.split('\n');
    const all = Array.from({ length: 300 }, (_, i) => `${(i + 1) % 2 ? 'Customer' : 'Team'}: ${body(i + 1)}`);
    // An unbroken stretch of the chat ending with the team's message after the target
    assert.deepEqual(context, all.slice(300 - context.length), 'the newest messages, in order, nothing skipped');
    assert.equal(context.at(-2), `Customer: ${body(299)}`);
    assert.ok(context.length > 60, `more than the old 60 when they fit (${context.length})`);
    assert.ok(context.length < 300, 'not the whole chat');
    assert.ok(context.slice(0, -2).join('\n').length <= REPLY_CONTEXT_CHARS.value, 'the text before the target stays within the budget');
    assert.doesNotMatch(content, /Message 001\b/);
    assert.doesNotMatch(content, /<summary>/);
    assert.match(system, /reply to that message/);
    assert.match(system, /do not summarize the chat/);
  });
  test("an older customer message is still the target, with the team's messages since; deleted ones are skipped", async () => {
    const id = await chatWith([
      { direction: 'out', body: 'Welcome to TyresCart' },
      { direction: 'in', body: 'Do you fit tyres on Sundays?' },
      ...Array.from({ length: 70 }, (_, i) => ({ direction: 'out' as const, body: label(i + 1) })),
      { direction: 'in', body: 'Withdrawn question', deletedAt: new Date() },
    ]);
    await suggestReply(auth('owner'), id);
    const { content } = asked[0];
    assert.equal(block(content, 'latest_customer_message'), 'Customer: Do you fit tyres on Sundays?');
    const context = block(content, 'conversation')!.split('\n');
    assert.deepEqual(context.slice(0, 2), ['Team: Welcome to TyresCart', 'Customer: Do you fit tyres on Sundays?']);
    assert.deepEqual(context.slice(2), Array.from({ length: 70 }, (_, i) => `Team: ${label(i + 1)}`), "the team's 70 messages since, so they aren't repeated");
    assert.doesNotMatch(content, /Withdrawn question/);
  });
  test('context is cut by size, not by count: a small budget keeps only the nearest messages', async () => {
    const id = await chatWith(Array.from({ length: 20 }, (_, i) => ({ direction: 'in' as const, body: label(i + 1) })));
    const budget = REPLY_CONTEXT_CHARS.value;
    REPLY_CONTEXT_CHARS.value = 60; // room for 2 lines of "Customer: Message 0nn"
    try {
      await suggestReply(auth('owner'), id);
    } finally {
      REPLY_CONTEXT_CHARS.value = budget;
    }
    assert.deepEqual(block(asked[0].content, 'conversation')!.split('\n'), ['Customer: Message 018', 'Customer: Message 019', 'Customer: Message 020']);
  });
  // Already answered by the team, or not: the AI decides from the team's messages since, sent on their own
  const answering = (answer: string) => setAiForTests(async (kind, system, content) => (asked.push({ kind, system, content }), answer));
  for (const [teamReply, aiAnswer] of [
    ['Yes, confirmed', 'ALREADY_ANSWERED'],
    ['Yes', 'ALREADY_ANSWERED'],
    ['Confirmed', 'ALREADY_ANSWERED.'],
    ['Done', '**ALREADY_ANSWERED**'],
  ] as const) {
    test(`answered: "Can you confirm my booking?" then the team's "${teamReply}" → no reply suggested, a clear note instead`, async () => {
      const id = await chatWith([
        { direction: 'in', body: 'Hi, I booked a fitting for Saturday 10am' },
        { direction: 'in', body: 'Can you confirm my booking?' },
        { direction: 'out', body: teamReply },
      ]);
      answering(aiAnswer);
      await assert.rejects(suggestReply(auth('owner'), id), { code: 'ALREADY_ANSWERED', message: "The team has already replied to the customer's latest message. There's nothing new to answer." });
      const { system, content } = asked[0];
      assert.equal(block(content, 'latest_customer_message'), 'Customer: Can you confirm my booking?');
      assert.equal(block(content, 'team_replies_since'), `Team: ${teamReply}`, "the team's reply since, on its own");
      assert.match(system, /output exactly ALREADY_ANSWERED/);
      assert.match(system, /"Yes", "Confirmed", "Done"/);
      assert.equal(await prisma.message.count({ where: { conversationId: id } }), 3, 'nothing saved or sent');
    });
  }
  test('not answered: the team only said thanks / "we will check" → a reply to the open question', async () => {
    const id = await chatWith([
      { direction: 'in', body: 'What is the price for 4 Michelin 205/55 R16?' },
      { direction: 'out', body: 'Thanks for your message!' },
      { direction: 'out', body: 'We will check' },
    ]);
    answering('The price for 4 Michelin 205/55 R16 tyres is being checked; we will send it shortly.');
    assert.match(await suggestReply(auth('owner'), id), /^The price for 4 Michelin/);
    assert.equal(block(asked[0].content, 'team_replies_since'), 'Team: Thanks for your message!\nTeam: We will check');
    assert.match(asked[0].system, /write the reply to what is still unanswered, without repeating what the team already said/);
  });
  // The AI's answers in turn, one per request
  const answers = (...list: string[]) => setAiForTests(async (kind, system, content) => (asked.push({ kind, system, content }), list[asked.length - 1] ?? 'unexpected extra request'));
  const REPLY = 'A reply to the latest question';

  test("an earlier question the team answered, then a new one: the new one is the target; the team's earlier reply is only context", async () => {
    const id = await chatWith([
      { direction: 'in', body: 'Can you confirm my booking?' },
      { direction: 'out', body: 'Yes, confirmed' },
      { direction: 'in', body: 'What is the price for wheel alignment?' },
    ]);
    answers(REPLY);
    assert.equal(await suggestReply(auth('owner'), id), REPLY);
    const { system, content } = asked[0];
    assert.equal(asked.length, 1);
    assert.equal(block(content, 'latest_customer_message'), 'Customer: What is the price for wheel alignment?');
    assert.equal(block(content, 'team_replies_since'), '(none)');
    assert.deepEqual(block(content, 'conversation')!.split('\n'), ['Customer: Can you confirm my booking?', 'Team: Yes, confirmed', 'Customer: What is the price for wheel alignment?']);
    assert.match(system, /they never count as answering the latest one/);
    assert.match(system, /When it says \(none\), always write the reply/);
  });
  test('the AI wrongly says "answered" because of a reply to an earlier message: asked again, and the reply to the latest is returned', async () => {
    const id = await chatWith([
      { direction: 'in', body: 'Can you confirm my booking?' },
      { direction: 'out', body: 'Yes, confirmed' },
      { direction: 'in', body: 'Can you also confirm the price?' },
    ]);
    answers('ALREADY_ANSWERED', REPLY);
    assert.equal(await suggestReply(auth('owner'), id), REPLY);
    assert.equal(asked.length, 2);
    assert.match(asked[1].content, /The team has not replied since the latest customer message, so ALREADY_ANSWERED is not possible here: write the reply to it\.$/);
    assert.equal(block(asked[1].content, 'latest_customer_message'), 'Customer: Can you also confirm the price?');
    await settle();
    // The two requests' entries: the wrong "answered" (not accepted), then the reply
    const logs = await prisma.logEntry.findMany({ where: { workspaceId: ws, event: 'ai.reply' }, orderBy: { createdAt: 'desc' }, take: 2 });
    assert.deepEqual(logs.map((l) => (l.data as { outcome?: string }).outcome).sort(), ['completed', 'rejected']);
  });
  test('still "answered" after being asked again: an error to try again, never "the team already replied"', async () => {
    const id = await chatWith([
      { direction: 'out', body: 'Hello from TyresCart' },
      { direction: 'in', body: 'Can you confirm my booking?' },
    ]);
    answers('ALREADY_ANSWERED', 'ALREADY_ANSWERED');
    await assert.rejects(suggestReply(auth('owner'), id), { code: 'AI_UNAVAILABLE', message: 'The AI gave an unusable answer. Try again.' });
    assert.equal(asked.length, 2);
  });
  test('several customer messages in a row after a team reply: the newest one is the target', async () => {
    const id = await chatWith([
      { direction: 'in', body: 'Do you have 205/55 R16?' },
      { direction: 'out', body: 'Yes, we have them' },
      { direction: 'in', body: 'Great' },
      { direction: 'in', body: 'Can you fit them tomorrow?' },
    ]);
    answers(REPLY);
    await suggestReply(auth('owner'), id);
    assert.equal(block(asked[0].content, 'latest_customer_message'), 'Customer: Can you fit them tomorrow?');
    assert.equal(block(asked[0].content, 'team_replies_since'), '(none)');
  });
  test("team replies between customer messages: only the ones after the latest customer message can answer it", async () => {
    const id = await chatWith([
      { direction: 'in', body: 'Can you confirm my booking?' },
      { direction: 'out', body: 'Yes, confirmed' },
      { direction: 'in', body: 'Please send the invoice' },
      { direction: 'out', body: 'Done' },
    ]);
    answers('ALREADY_ANSWERED');
    await assert.rejects(suggestReply(auth('owner'), id), { code: 'ALREADY_ANSWERED' });
    assert.equal(block(asked[0].content, 'latest_customer_message'), 'Customer: Please send the invoice');
    assert.equal(block(asked[0].content, 'team_replies_since'), 'Team: Done', "not the reply to the earlier message");
  });
  test("the latest customer message was deleted: the one before it is the target, with every team reply after it", async () => {
    const id = await chatWith([
      { direction: 'in', body: 'What time do you open on Friday?' },
      { direction: 'out', body: 'One moment please' },
      { direction: 'in', body: 'Never mind', deletedAt: new Date() },
      { direction: 'out', body: 'Are you still there?' },
    ]);
    answers(REPLY);
    assert.equal(await suggestReply(auth('owner'), id), REPLY);
    assert.equal(block(asked[0].content, 'latest_customer_message'), 'Customer: What time do you open on Friday?');
    assert.equal(block(asked[0].content, 'team_replies_since'), 'Team: One moment please\nTeam: Are you still there?');
    assert.doesNotMatch(asked[0].content, /Never mind/);
  });
  test('the log says the team already answered (no text), as its own outcome', async () => {
    const id = await chatWith([
      { direction: 'in', body: 'Is my order sent?' },
      { direction: 'out', body: 'Sent' },
    ]);
    answering('ALREADY_ANSWERED');
    await assert.rejects(suggestReply(auth('owner'), id), { code: 'ALREADY_ANSWERED' });
    await settle();
    const log = await prisma.logEntry.findFirstOrThrow({ where: { workspaceId: ws, event: 'ai.reply' }, orderBy: { createdAt: 'desc' } });
    assert.match(log.message, /team already answered the customer's latest message/);
    assert.equal((log.data as { outcome?: string }).outcome, 'already_answered');
    assert.doesNotMatch(JSON.stringify(log), /Is my order sent|"Sent"/);
  });
  test('no message from the customer yet: refused, the AI is not asked', async () => {
    const id = await chatWith([{ direction: 'out', body: 'Hello from TyresCart' }]);
    await assert.rejects(suggestReply(auth('owner'), id), { code: 'NO_MESSAGES', message: "The customer hasn't written anything to reply to yet." });
    assert.equal(asked.length, 0);
  });
  test('the same rules as replying: an agent only after Assign to Me; supervisors may reply to an unheld chat', async () => {
    await assert.rejects(suggestReply(auth('agent'), chat), { code: 'NOT_ASSIGNED' });
    assert.equal(asked.length, 0);
    assert.match(await suggestReply(auth('sup'), chat), /^Reply/);
    await assignConversation(ws, chat, people.agent.memberId, people.owner.userId, 'AI test');
    assert.match(await suggestReply(auth('agent'), chat), /^Reply/);
    await assert.rejects(suggestReply(auth('outsider', other), chat), { code: 'NOT_FOUND' });
  });
  test('a closed chat or a closed 24-hour window: refused like a reply, the AI is not asked', async () => {
    await prisma.conversation.update({ where: { id: chat }, data: { lastInboundAt: new Date(Date.now() - 25 * 3600_000) } });
    await assert.rejects(suggestReply(auth('owner'), chat), { code: 'WINDOW_CLOSED' });
    await prisma.conversation.update({ where: { id: chat }, data: { lastInboundAt: new Date(), status: 'closed' } });
    await assert.rejects(suggestReply(auth('owner'), chat), { code: 'CONVERSATION_CLOSED' });
    assert.equal(asked.length, 0);
    await prisma.conversation.update({ where: { id: chat }, data: { status: 'open' } });
  });
});

test("the reply's context: oldest first, Customer/Team, deleted messages left out, media named by type", async () => {
  asked = [];
  const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: chat } });
  await prisma.message.create({ data: { conversationId: conv.id, direction: 'out', type: 'text', body: 'Removed text', status: 'sent', deletedAt: new Date() } });
  await prisma.message.create({ data: { conversationId: conv.id, direction: 'out', type: 'document', body: '', mediaName: 'price-list.pdf', status: 'sent' } });
  await suggestReply(auth('owner'), chat);
  const context = /<conversation>\n([\s\S]*?)\n<\/conversation>/.exec(asked[0].content)![1];
  assert.doesNotMatch(context, /Removed text/);
  assert.match(context, /Team: \[document: price-list\.pdf\]$/);
  assert.ok(context.indexOf('205/55') < context.indexOf('Toyota'));
});

test('deleting the chat removes its summary (cascade)', async () => {
  assert.equal(await prisma.conversationSummary.count({ where: { conversationId: chat } }), 1);
  await prisma.conversation.delete({ where: { id: chat } });
  assert.equal(await prisma.conversationSummary.count({ where: { conversationId: chat } }), 0);
});
