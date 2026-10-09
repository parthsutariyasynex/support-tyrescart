// End-to-end tests for the GraphQL Inbox + Settings API (and REST parity).
// Needs the API running (npm run dev) against a dev database and NODE_ENV != production.
// Run: npm run test:e2e   (API_URL defaults to http://localhost:4000)
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { prisma } from '../src/prisma.js';

const API = process.env.API_URL ?? 'http://localhost:4000';
const run = Date.now();
const created: { userIds: string[]; workspaceIds: string[] } = { userIds: [], workspaceIds: [] };

type GqlResult<T = any> = { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };

async function gql<T = any>(query: string, variables?: object, token?: string): Promise<GqlResult<T>> {
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  return res.json() as Promise<GqlResult<T>>;
}

async function ok<T = any>(query: string, variables?: object, token?: string): Promise<T> {
  const r = await gql<T>(query, variables, token);
  assert.equal(r.errors, undefined, JSON.stringify(r.errors));
  return r.data!;
}

async function errorCode(query: string, variables?: object, token?: string) {
  const r = await gql(query, variables, token);
  assert.ok(r.errors?.length, `expected an error, got ${JSON.stringify(r.data)}`);
  return r.errors![0].extensions?.code;
}

async function rest(method: string, path: string, token: string, body?: object) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function newWorkspace(label: string) {
  const data = await ok(
    `mutation($i: RegisterInput!) { register(input: $i) { token user { id } workspace { id } } }`,
    { i: { name: label, email: `e2e-${label}-${run}@example.com`, password: 'password123', workspaceName: label } },
  );
  created.userIds.push(data.register.user.id);
  created.workspaceIds.push(data.register.workspace.id);
  return { token: data.register.token as string, workspaceId: data.register.workspace.id as string };
}

const SIMULATE = `mutation($i: SimulateIncomingInput) { simulateIncomingMessage(input: $i) }`;
const CONVERSATIONS = `query($first: Int, $after: String) {
  conversations(first: $first, after: $after) {
    nodes { id unread lastMessageAt lastInboundAt contact { waId name } lastMessage { body direction } }
    pageInfo { hasNextPage endCursor }
  }
}`;
const MESSAGES = `query($id: ID!, $first: Int, $after: String) {
  messages(conversationId: $id, first: $first, after: $after) {
    nodes { id body direction status createdAt conversationId }
    pageInfo { hasNextPage endCursor }
  }
}`;

let A: { token: string; workspaceId: string };
let B: { token: string; workspaceId: string };

before(async () => {
  A = await newWorkspace('a');
  B = await newWorkspace('b');
});

after(async () => {
  // Delete children first: on MySQL 9 (macOS) the multi-path cascade Workspace -> Contact/Conversation
  // has left Conversation rows behind, so don't rely on it here.
  const workspaceId = { in: created.workspaceIds };
  await prisma.message.deleteMany({ where: { conversation: { workspaceId } } });
  await prisma.conversation.deleteMany({ where: { workspaceId } });
  await prisma.contact.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
  await prisma.$disconnect();
});

describe('authentication', () => {
  const protectedOps = [
    `{ conversations { nodes { id } } }`,
    `{ conversation(id: "x") { id } }`,
    `{ messages(conversationId: "x") { nodes { id } } }`,
    `{ whatsappAccount { wabaId } }`,
    `mutation { markConversationRead(id: "x") { id } }`,
    `mutation { sendTextMessage(input: { conversationId: "x", body: "hi" }) { id } }`,
    `mutation { sendTemplateMessage(input: { conversationId: "x", name: "hello_world" }) { id } }`,
    `mutation { startConversation(input: { waId: "919876543210" }) { id } }`,
    `mutation { simulateIncomingMessage }`,
    `mutation { connectWhatsApp(input: { wabaId: "1", phoneNumberId: "1", accessToken: "xxxxxxxxxxxx" }) { wabaId } }`,
  ];
  for (const op of protectedOps)
    test(`rejects without token: ${op.slice(0, 60)}`, async () => {
      assert.equal(await errorCode(op), 'UNAUTHENTICATED');
      assert.equal(await errorCode(op, undefined, 'not-a-jwt'), 'UNAUTHENTICATED');
    });
});

describe('inbox', () => {
  let conversationId: string;

  test('simulated incoming message creates a conversation', async () => {
    await ok(SIMULATE, { i: { waId: '911111111111', name: 'Asha', body: 'Hello there' } }, A.token);
    const { conversations } = await ok(CONVERSATIONS, {}, A.token);
    assert.equal(conversations.nodes.length, 1);
    const c = conversations.nodes[0];
    assert.equal(c.contact.waId, '911111111111');
    assert.equal(c.contact.name, 'Asha');
    assert.equal(c.unread, 1);
    assert.equal(c.lastMessage.body, 'Hello there');
    assert.equal(c.lastMessage.direction, 'in');
    assert.ok(c.lastInboundAt);
    conversationId = c.id;
  });

  test('conversation and messages queries', async () => {
    const { conversation } = await ok(`query($id: ID!) { conversation(id: $id) { id contact { waId } lastMessage { body } } }`, { id: conversationId }, A.token);
    assert.equal(conversation.contact.waId, '911111111111');
    assert.equal(conversation.lastMessage.body, 'Hello there');

    const { messages } = await ok(MESSAGES, { id: conversationId }, A.token);
    assert.equal(messages.nodes.length, 1);
    assert.equal(messages.nodes[0].conversationId, conversationId);
    assert.equal(messages.pageInfo.hasNextPage, false);
  });

  test('markConversationRead resets unread', async () => {
    const { markConversationRead } = await ok(`mutation($id: ID!) { markConversationRead(id: $id) { id unread } }`, { id: conversationId }, A.token);
    assert.equal(markConversationRead.unread, 0);
  });

  test('message pagination: newest page first, oldest -> newest within a page', async () => {
    for (const body of ['m2', 'm3', 'm4', 'm5']) {
      await ok(SIMULATE, { i: { waId: '911111111111', body } }, A.token);
      await new Promise((r) => setTimeout(r, 15)); // distinct createdAt
    }
    const p1 = (await ok(MESSAGES, { id: conversationId, first: 2 }, A.token)).messages;
    assert.deepEqual(p1.nodes.map((m: any) => m.body), ['m4', 'm5']);
    assert.equal(p1.pageInfo.hasNextPage, true);
    const p2 = (await ok(MESSAGES, { id: conversationId, first: 2, after: p1.pageInfo.endCursor }, A.token)).messages;
    assert.deepEqual(p2.nodes.map((m: any) => m.body), ['m2', 'm3']);
    const p3 = (await ok(MESSAGES, { id: conversationId, first: 2, after: p2.pageInfo.endCursor }, A.token)).messages;
    assert.deepEqual(p3.nodes.map((m: any) => m.body), ['Hello there']);
    assert.equal(p3.pageInfo.hasNextPage, false);
  });

  test('conversation pagination walks every conversation exactly once', async () => {
    await ok(SIMULATE, { i: { waId: '912222222222', body: 'second' } }, A.token);
    await ok(SIMULATE, { i: { waId: '913333333333', body: 'third' } }, A.token);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const { conversations }: any = await ok(CONVERSATIONS, { first: 1, after: cursor }, A.token);
      seen.push(...conversations.nodes.map((c: any) => c.contact.waId));
      cursor = conversations.pageInfo.hasNextPage ? conversations.pageInfo.endCursor : null;
      pages++;
    } while (cursor && pages < 10);
    assert.deepEqual(seen, ['913333333333', '912222222222', '911111111111']);
  });

  test('page size and input validation', async () => {
    assert.equal(await errorCode(CONVERSATIONS, { first: 0 }, A.token), 'BAD_USER_INPUT');
    assert.equal(await errorCode(CONVERSATIONS, { first: 101 }, A.token), 'BAD_USER_INPUT');
    assert.equal(await errorCode(CONVERSATIONS, { after: 'unknown-cursor' }, A.token), 'NOT_FOUND');
    assert.equal(await errorCode(MESSAGES, { id: conversationId, after: 'unknown' }, A.token), 'NOT_FOUND');
    assert.equal(
      await errorCode(`mutation { sendTextMessage(input: { conversationId: "${conversationId}", body: "" }) { id } }`, undefined, A.token),
      'BAD_USER_INPUT',
    );
    assert.equal(
      await errorCode(`mutation { startConversation(input: { waId: "123" }) { id } }`, undefined, A.token),
      'BAD_USER_INPUT',
    );
  });

  test('sending without a connected WhatsApp number is refused and stores nothing', async () => {
    const before = await prisma.message.count({ where: { conversationId } });
    assert.equal(
      await errorCode(`mutation($i: SendTextInput!) { sendTextMessage(input: $i) { id } }`, { i: { conversationId, body: 'hi' } }, A.token),
      'WHATSAPP_NOT_CONNECTED',
    );
    assert.equal(
      await errorCode(`mutation($i: SendTemplateInput!) { sendTemplateMessage(input: $i) { id } }`, { i: { conversationId, name: 'hello_world' } }, A.token),
      'WHATSAPP_NOT_CONNECTED',
    );
    assert.equal(await prisma.message.count({ where: { conversationId } }), before);
  });

  test('startConversation normalises the number and is idempotent', async () => {
    const q = `mutation($i: StartConversationInput!) { startConversation(input: $i) { id unread contact { waId name } lastMessage { id } } }`;
    const first = (await ok(q, { i: { waId: '+91 98765-43210', name: 'Ravi' } }, A.token)).startConversation;
    assert.equal(first.contact.waId, '919876543210');
    assert.equal(first.contact.name, 'Ravi');
    assert.equal(first.lastMessage, null);
    const again = (await ok(q, { i: { waId: '919876543210' } }, A.token)).startConversation;
    assert.equal(again.id, first.id);
  });

  test('workspace isolation: another workspace cannot see or touch the conversation', async () => {
    assert.equal(await errorCode(`query($id: ID!) { conversation(id: $id) { id } }`, { id: conversationId }, B.token), 'NOT_FOUND');
    assert.equal(await errorCode(MESSAGES, { id: conversationId }, B.token), 'NOT_FOUND');
    assert.equal(await errorCode(`mutation($id: ID!) { markConversationRead(id: $id) { id } }`, { id: conversationId }, B.token), 'NOT_FOUND');
    assert.equal(
      await errorCode(`mutation($i: SendTextInput!) { sendTextMessage(input: $i) { id } }`, { i: { conversationId, body: 'x' } }, B.token),
      'NOT_FOUND',
    );
    // B's cursor into A's data is rejected rather than leaking A's rows
    assert.equal(await errorCode(CONVERSATIONS, { after: conversationId }, B.token), 'NOT_FOUND');
    const { conversations } = await ok(CONVERSATIONS, {}, B.token);
    assert.equal(conversations.nodes.length, 0);
  });
});

describe('settings', () => {
  test('whatsappAccount is null before connecting', async () => {
    assert.equal((await ok(`{ whatsappAccount { wabaId } }`, undefined, A.token)).whatsappAccount, null);
  });

  test('connectWhatsApp validates input', async () => {
    assert.equal(
      await errorCode(`mutation { connectWhatsApp(input: { wabaId: "1", phoneNumberId: "1", accessToken: "short" }) { wabaId } }`, undefined, A.token),
      'BAD_USER_INPUT',
    );
  });

  test('connectWhatsApp rejects credentials Meta does not accept, and saves nothing', async () => {
    const code = await errorCode(
      `mutation { connectWhatsApp(input: { wabaId: "1", phoneNumberId: "1", accessToken: "invalid-token-e2e" }) { wabaId } }`,
      undefined,
      A.token,
    );
    assert.ok(code === 'INVALID_CREDENTIALS' || code === 'META_UNREACHABLE', `got ${code}`);
    assert.equal(await prisma.whatsAppAccount.count({ where: { workspaceId: A.workspaceId } }), 0);
  });

  test('whatsappAccount returns the connected number and never exposes the token', async () => {
    await prisma.whatsAppAccount.create({
      data: { workspaceId: A.workspaceId, wabaId: 'waba-e2e', phoneNumberId: `pn-e2e-${run}`, displayPhone: '+1 555 0100', accessToken: 'secret-e2e' },
    });
    const { whatsappAccount } = await ok(`{ whatsappAccount { wabaId phoneNumberId displayPhone } }`, undefined, A.token);
    assert.deepEqual(whatsappAccount, { wabaId: 'waba-e2e', phoneNumberId: `pn-e2e-${run}`, displayPhone: '+1 555 0100' });
    const r = await gql(`{ whatsappAccount { accessToken } }`, undefined, A.token);
    assert.match(r.errors?.[0].message ?? '', /Cannot query field "accessToken"/);
    // Other workspaces don't see it
    assert.equal((await ok(`{ whatsappAccount { wabaId } }`, undefined, B.token)).whatsappAccount, null);
  });

  test('with a number connected, closed 24h window blocks free text', async () => {
    const { startConversation } = await ok(`mutation { startConversation(input: { waId: "914444444444" }) { id } }`, undefined, A.token);
    assert.equal(
      await errorCode(`mutation($i: SendTextInput!) { sendTextMessage(input: $i) { id } }`, { i: { conversationId: startConversation.id, body: 'hi' } }, A.token),
      'WINDOW_CLOSED',
    );
  });
});

describe('REST routes still work (parity)', () => {
  test('inbox and settings REST endpoints', async () => {
    const list = await rest('GET', '/inbox/conversations', A.token);
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body) && list.body.length >= 4);
    assert.ok(list.body[0].contact && Array.isArray(list.body[0].messages));

    const open = await rest('GET', `/inbox/conversations/${list.body.at(-1).id}/messages`, A.token);
    assert.equal(open.status, 200);
    assert.ok(open.body.conversation && Array.isArray(open.body.messages));

    assert.equal((await rest('GET', `/inbox/conversations/${list.body[0].id}/messages`, B.token)).status, 404);
    assert.equal((await rest('POST', '/inbox/contacts', A.token, { waId: '12' })).status, 400);
    assert.equal((await rest('POST', '/inbox/dev/simulate-incoming', B.token, {})).status, 200);
    assert.equal((await rest('POST', '/settings/whatsapp', A.token, { wabaId: '1' })).status, 400);
  });
});
