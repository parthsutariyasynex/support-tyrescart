// Replies, WhatsApp style: a message can quote another one of the same chat. Sent replies carry WhatsApp's
// `context` (so the customer sees the quote too); a customer's reply to one of ours is linked to it. Runs in this
// process with WhatsApp replaced by a mock (nothing is sent). The API server must be running (API_URL) for sign-ups.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';

const payloads: any[] = []; // what was sent to the (mock) WhatsApp API
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url?.endsWith('/media')) return res.end(JSON.stringify({ id: `media-${Date.now()}` }));
    if (req.url?.endsWith('/messages')) {
      payloads.push(JSON.parse(body || '{}'));
      return res.end(JSON.stringify({ messages: [{ id: `wamid.out-${Date.now()}-${Math.random().toString(36).slice(2)}` }] }));
    }
    res.end('{}');
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

let messages: typeof import('../src/messages.js');
let inbox: typeof import('../src/services/inbox.js');
let senders: typeof import('../src/services/senders.js');
let prisma: typeof import('../src/prisma.js')['prisma'];
before(async () => {
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
  process.env.GRAPH_API_BASE = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
  messages = await import('../src/messages.js');
  inbox = await import('../src/services/inbox.js');
  senders = await import('../src/services/senders.js');
  prisma = (await import('../src/prisma.js')).prisma;
});
after(async () => {
  mock.close();
  await prisma?.$disconnect();
});

describe('reading a reply from the webhook', () => {
  test('context.id is the quoted message; a forwarded message (context without an id) is not a reply', () => {
    const base = { from: '971500000001', id: 'wamid.in-1', type: 'text', text: { body: 'Yes, that one' } };
    assert.equal(messages.parseWebhookMessage({ ...base, context: { from: '15550001', id: 'wamid.ours-1' } }).replyToWaId, 'wamid.ours-1');
    assert.equal(messages.parseWebhookMessage({ ...base, context: { forwarded: true } }).replyToWaId, undefined);
    assert.equal(messages.parseWebhookMessage(base).replyToWaId, undefined);
  });
});

describe('replies in a chat', () => {
  test('text, image and customer replies are quoted; only messages of the same chat, not deleted ones', async () => {
    const reg = `mutation($i: RegisterInput!) { register(input: $i) { token user { id } workspace { id } } }`;
    const o = (await gql(reg, { i: { name: `Owner ${run}`, email: `e2e-reply-o-${run}@example.com`, password: 'password123', workspaceName: `Reply Co ${run}` } })).register;
    const ws = o.workspace.id;
    await prisma.whatsAppAccount.create({ data: { workspaceId: ws, wabaId: `waba-r-${run}`, phoneNumberId: `pn-r-${run}`, displayPhone: `+1 555 ${String(run).slice(-7)}`, accessToken: 'mock-token' } });
    const waA = `9715${String(run).slice(-8)}`;
    const waB = `9716${String(run).slice(-8)}`;
    const nameA = `Cust ${run.toString(36)}`;

    // the customer writes; we reply to that message
    await messages.saveIncoming(ws, { waId: waA, name: nameA, type: 'text', body: 'Do you have 17 inch tyres?', waMessageId: `wamid.r-${run}-1` });
    const conv = await prisma.conversation.findFirstOrThrow({ where: { workspaceId: ws, contact: { waId: waA } } });
    const question = await prisma.message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'in' } });
    const reply = await inbox.sendMessage(ws, conv.id, { type: 'text', body: 'Yes, in stock', replyToId: question.id }, o.user.id);
    assert.equal(reply.replyToId, question.id);
    assert.equal(reply.status, 'sent');
    assert.deepEqual(payloads.at(-1).context, { message_id: question.waMessageId }); // WhatsApp shows the quote too

    // loaded through the API: the quote has who wrote it and the text
    const page = (await gql(`query($id: ID!) { messages(conversationId: $id, first: 20) { nodes { id body replyToId replyTo { id direction body senderName deleted } } } }`, { id: conv.id }, o.token)).messages.nodes;
    const loaded = page.find((m: any) => m.id === reply.id);
    assert.deepEqual(loaded.replyTo, { id: question.id, direction: 'in', body: 'Do you have 17 inch tyres?', senderName: nameA, deleted: false });
    assert.equal(page.find((m: any) => m.id === question.id).replyTo, null); // not a reply

    // live (socket) messages carry the same quote
    assert.equal((await senders.withSender(reply)).replyTo?.id, question.id);

    // a plain message has no context
    await inbox.sendMessage(ws, conv.id, { type: 'text', body: 'Anything else?' }, o.user.id);
    assert.equal(payloads.at(-1).context, undefined);

    // an image can be a reply too (the context goes with the image)
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const photo = await inbox.sendMediaMessage('image', ws, conv.id, png, 'image/png', 'This one', null, o.user.id, question.id);
    assert.equal(photo.replyToId, question.id);
    assert.equal(payloads.at(-1).type, 'image');
    assert.deepEqual(payloads.at(-1).context, { message_id: question.waMessageId });

    // the customer replies to our message: linked to it
    await messages.saveIncoming(ws, { waId: waA, name: nameA, type: 'text', body: 'Great, how much?', waMessageId: `wamid.r-${run}-2`, replyToWaId: reply.waMessageId! });
    const back = await prisma.message.findUniqueOrThrow({ where: { waMessageId: `wamid.r-${run}-2` } });
    assert.equal(back.replyToId, reply.id);
    const quote = await senders.quoteOf(back.replyToId);
    assert.equal(quote?.senderName, `Owner ${run}`);
    assert.equal(quote?.body, 'Yes, in stock');
    // a reply to something this app doesn't have (sent before it, or elsewhere) is just a message
    await messages.saveIncoming(ws, { waId: waA, name: nameA, type: 'text', body: 'And this?', waMessageId: `wamid.r-${run}-3`, replyToWaId: 'wamid.unknown' });
    assert.equal((await prisma.message.findUniqueOrThrow({ where: { waMessageId: `wamid.r-${run}-3` } })).replyToId, null);

    // only messages of the same chat
    await messages.saveIncoming(ws, { waId: waB, name: 'Other', type: 'text', body: 'Hi', waMessageId: `wamid.r-${run}-4` });
    const otherConv = await prisma.conversation.findFirstOrThrow({ where: { workspaceId: ws, contact: { waId: waB } } });
    const otherMsg = await prisma.message.findFirstOrThrow({ where: { conversationId: otherConv.id } });
    await assert.rejects(inbox.sendMessage(ws, conv.id, { type: 'text', body: 'Wrong chat', replyToId: otherMsg.id }, o.user.id), /isn't in this chat/);
    // a customer quoting a message from another chat isn't linked either
    await messages.saveIncoming(ws, { waId: waB, name: 'Other', type: 'text', body: 'Hm', waMessageId: `wamid.r-${run}-5`, replyToWaId: reply.waMessageId! });
    assert.equal((await prisma.message.findUniqueOrThrow({ where: { waMessageId: `wamid.r-${run}-5` } })).replyToId, null);

    // not to a deleted message; a quote of a message deleted later shows it was deleted, without its text
    await prisma.message.update({ where: { id: question.id }, data: { deletedAt: new Date() } });
    await assert.rejects(inbox.sendMessage(ws, conv.id, { type: 'text', body: 'Late', replyToId: question.id }, o.user.id), /deleted message/);
    assert.deepEqual(await senders.quoteOf(question.id).then((q) => ({ body: q?.body, deleted: q?.deleted })), { body: '', deleted: true });
  });
});
