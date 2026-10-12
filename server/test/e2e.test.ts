// End-to-end tests for the GraphQL Inbox + Settings API (and REST parity).
// Needs the API running (npm run dev) against a dev database and NODE_ENV != production.
// Run: npm run test:e2e   (API_URL defaults to http://localhost:4000)
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import bcrypt from 'bcryptjs';
import { createHash, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { io as connectSocket, type Socket } from 'socket.io-client';
import { prisma } from '../src/prisma.js';
import { validSignature } from '../src/routes/webhook.js';
import { pickTemplateLanguage } from '../src/services/inbox.js';
import { parseQuickReplyDump, possibleLostEmojis } from '../src/services/quickReplyImport.js';
import type { ApprovedTemplate } from '../src/whatsapp.js';

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
  await prisma.conversationLabel.deleteMany({ where: { label: { workspaceId } } });
  await prisma.label.deleteMany({ where: { workspaceId } });
  await prisma.conversation.updateMany({ where: { workspaceId }, data: { assignedToId: null } });
  await prisma.assignee.deleteMany({ where: { workspaceId } });
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
    `{ labels { id } }`,
    `mutation { createLabel(input: { name: "x", color: "#25d366" }) { id } }`,
    `mutation { updateLabel(id: "x", input: { name: "y" }) { id } }`,
    `mutation { deleteLabel(id: "x") }`,
    `mutation { addConversationLabel(conversationId: "x", labelId: "x") { id } }`,
    `mutation { removeConversationLabel(conversationId: "x", labelId: "x") { id } }`,
    `{ assignees { id } }`,
    `mutation { createAssignee(input: { name: "x", color: "#25d366" }) { id } }`,
    `mutation { updateAssignee(id: "x", input: { name: "y" }) { id } }`,
    `mutation { deleteAssignee(id: "x") }`,
    `mutation { assignConversation(conversationId: "x", assigneeId: "x") { id } }`,
    `mutation { setLabelPermission(userId: "x", canManageLabels: true) { userId } }`,
    `mutation { editMessage(input: { messageId: "x", body: "y", version: 0 }) { id } }`,
    `mutation { deleteMessage(messageId: "x") { id } }`,
    `mutation { restoreMessage(messageId: "x", version: 0) { id } }`,
    `mutation { closeConversation(id: "x") { id } }`,
    `mutation { reopenConversation(id: "x") { id } }`,
    `{ conversationCounts { open } }`,
    `{ workspaces { id } }`,
    `mutation { createWorkspace(name: "x") { token } }`,
    `mutation { switchWorkspace(id: "x") { token } }`,
    `{ conversationActivity(conversationId: "x") { id } }`,
    `{ notifications { unseen } }`,
    `{ unreadTotal }`,
    `mutation { markNotificationsSeen }`,
    `mutation { clearConversation(id: "x") }`,
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

describe('labels', () => {
  const LABEL = 'id name color conversationCount';
  const CREATE = `mutation($i: CreateLabelInput!) { createLabel(input: $i) { ${LABEL} } }`;
  const UPDATE = `mutation($id: ID!, $i: UpdateLabelInput!) { updateLabel(id: $id, input: $i) { ${LABEL} } }`;
  const ADD = `mutation($c: ID!, $l: ID!) { addConversationLabel(conversationId: $c, labelId: $l) { id labels { id name color } } }`;
  const REMOVE = `mutation($c: ID!, $l: ID!) { removeConversationLabel(conversationId: $c, labelId: $l) { id labels { id name } } }`;
  const FILTERED = `query($labelId: ID, $first: Int, $after: String) {
    conversations(labelId: $labelId, first: $first, after: $after) {
      nodes { id contact { waId } labels { name } } pageInfo { hasNextPage endCursor }
    }
  }`;
  let vip: any;
  let urgent: any;
  let ids: string[];

  before(async () => {
    const { conversations } = await ok(CONVERSATIONS, {}, A.token);
    ids = conversations.nodes.map((c: any) => c.id);
    assert.ok(ids.length >= 3);
  });

  test('create labels (colour normalised, sorted by name)', async () => {
    vip = (await ok(CREATE, { i: { name: '  VIP ', color: '#25D366' } }, A.token)).createLabel;
    assert.deepEqual([vip.name, vip.color, vip.conversationCount], ['VIP', '#25d366', 0]);
    urgent = (await ok(CREATE, { i: { name: 'Urgent', color: '#ff3b30' } }, A.token)).createLabel;
    const { labels } = await ok(`{ labels { name } }`, undefined, A.token);
    assert.deepEqual(labels.map((l: any) => l.name), ['Urgent', 'VIP']);
  });

  test('validation and duplicate names', async () => {
    assert.equal(await errorCode(CREATE, { i: { name: ' ', color: '#25d366' } }, A.token), 'BAD_USER_INPUT');
    assert.equal(await errorCode(CREATE, { i: { name: 'x'.repeat(51), color: '#25d366' } }, A.token), 'BAD_USER_INPUT');
    assert.equal(await errorCode(CREATE, { i: { name: 'Bad', color: 'red' } }, A.token), 'BAD_USER_INPUT');
    assert.equal(await errorCode(CREATE, { i: { name: 'vip', color: '#000000' } }, A.token), 'LABEL_EXISTS');
    assert.equal(await errorCode(UPDATE, { id: urgent.id, i: { name: 'VIP' } }, A.token), 'LABEL_EXISTS');
    // Same name is fine in another workspace
    await ok(CREATE, { i: { name: 'VIP', color: '#000000' } }, B.token);
  });

  test('assign and remove labels on conversations (idempotent)', async () => {
    let c = (await ok(ADD, { c: ids[0], l: vip.id }, A.token)).addConversationLabel;
    c = (await ok(ADD, { c: ids[0], l: vip.id }, A.token)).addConversationLabel;
    c = (await ok(ADD, { c: ids[0], l: urgent.id }, A.token)).addConversationLabel;
    assert.deepEqual(c.labels.map((l: any) => l.name), ['Urgent', 'VIP']);
    await ok(ADD, { c: ids[1], l: vip.id }, A.token);
    await ok(ADD, { c: ids[2], l: vip.id }, A.token);
    const { labels } = await ok(`{ labels { name conversationCount } }`, undefined, A.token);
    assert.deepEqual(labels, [
      { name: 'Urgent', conversationCount: 1 },
      { name: 'VIP', conversationCount: 3 },
    ]);
    const removed = (await ok(REMOVE, { c: ids[2], l: vip.id }, A.token)).removeConversationLabel;
    assert.deepEqual(removed.labels, []);
    // Removing again is a no-op
    await ok(REMOVE, { c: ids[2], l: vip.id }, A.token);
  });

  test('conversations can be filtered by label, with pagination', async () => {
    const all = (await ok(FILTERED, { labelId: vip.id }, A.token)).conversations;
    assert.deepEqual(all.nodes.map((c: any) => c.id), [ids[0], ids[1]]);
    const p1 = (await ok(FILTERED, { labelId: vip.id, first: 1 }, A.token)).conversations;
    assert.equal(p1.pageInfo.hasNextPage, true);
    const p2 = (await ok(FILTERED, { labelId: vip.id, first: 1, after: p1.pageInfo.endCursor }, A.token)).conversations;
    assert.deepEqual([...p1.nodes, ...p2.nodes].map((c: any) => c.id), [ids[0], ids[1]]);
    assert.equal(p2.pageInfo.hasNextPage, false);
    assert.deepEqual((await ok(FILTERED, { labelId: urgent.id }, A.token)).conversations.nodes.map((c: any) => c.id), [ids[0]]);
    // Unfiltered list still returns everything, with labels attached
    const unfiltered = (await ok(FILTERED, {}, A.token)).conversations.nodes;
    assert.equal(unfiltered.length, ids.length);
    assert.deepEqual(unfiltered.find((c: any) => c.id === ids[0]).labels.map((l: any) => l.name), ['Urgent', 'VIP']);
  });

  test('editing a label updates it everywhere', async () => {
    const updated = (await ok(UPDATE, { id: vip.id, i: { name: 'Gold', color: null } }, A.token)).updateLabel;
    assert.equal(updated.name, 'Gold');
    assert.equal(updated.color, '#25d366');
    assert.equal(updated.conversationCount, 2);
    const { conversation } = await ok(`query($id: ID!) { conversation(id: $id) { labels { name } } }`, { id: ids[1] }, A.token);
    assert.deepEqual(conversation.labels, [{ name: 'Gold' }]);
  });

  test('workspace isolation for labels', async () => {
    const { labels } = await ok(`{ labels { name } }`, undefined, B.token);
    assert.deepEqual(labels, [{ name: 'VIP' }]);
    assert.equal(await errorCode(UPDATE, { id: vip.id, i: { name: 'hack' } }, B.token), 'NOT_FOUND');
    assert.equal(await errorCode(`mutation($id: ID!) { deleteLabel(id: $id) }`, { id: vip.id }, B.token), 'NOT_FOUND');
    assert.equal(await errorCode(ADD, { c: ids[0], l: vip.id }, B.token), 'NOT_FOUND');
    const bLabel = (await prisma.label.findFirst({ where: { workspaceId: B.workspaceId } }))!;
    // A cannot put B's label on its own conversation
    assert.equal(await errorCode(ADD, { c: ids[0], l: bLabel.id }, A.token), 'NOT_FOUND');
    assert.equal((await ok(FILTERED, { labelId: vip.id }, B.token)).conversations.nodes.length, 0);
  });

  test('deleting a label removes it from conversations', async () => {
    const { deleteLabel } = await ok(`mutation($id: ID!) { deleteLabel(id: $id) }`, { id: vip.id }, A.token);
    assert.equal(deleteLabel, vip.id);
    assert.equal(await prisma.conversationLabel.count({ where: { labelId: vip.id } }), 0);
    const { conversation } = await ok(`query($id: ID!) { conversation(id: $id) { labels { name } } }`, { id: ids[0] }, A.token);
    assert.deepEqual(conversation.labels, [{ name: 'Urgent' }]);
    assert.equal(await errorCode(`mutation($id: ID!) { deleteLabel(id: $id) }`, { id: vip.id }, A.token), 'NOT_FOUND');
  });
});

describe('assignees', () => {
  const FIELDS = 'id name color conversationCount';
  const CREATE = `mutation($i: CreateAssigneeInput!) { createAssignee(input: $i) { ${FIELDS} } }`;
  const UPDATE = `mutation($id: ID!, $i: UpdateAssigneeInput!) { updateAssignee(id: $id, input: $i) { ${FIELDS} } }`;
  const DELETE = `mutation($id: ID!) { deleteAssignee(id: $id) }`;
  const ASSIGN = `mutation($c: ID!, $a: ID) { assignConversation(conversationId: $c, assigneeId: $a) { id assignee { id name color } } }`;
  const BY_ASSIGNEE = `query($assignee: ID) { conversations(assignee: $assignee) { nodes { id assignee { name } } } }`;
  let kiran: any;
  let zara: any;
  let ids: string[];

  before(async () => {
    ids = (await ok(CONVERSATIONS, {}, A.token)).conversations.nodes.map((c: any) => c.id);
  });

  test('create assignees (colour normalised, sorted by name)', async () => {
    zara = (await ok(CREATE, { i: { name: ' Zara ', color: '#FF9500' } }, A.token)).createAssignee;
    kiran = (await ok(CREATE, { i: { name: 'Kiran', color: '#34b7f1' } }, A.token)).createAssignee;
    assert.deepEqual([zara.name, zara.color, zara.conversationCount], ['Zara', '#ff9500', 0]);
    const { assignees } = await ok(`{ assignees { name } }`, undefined, A.token);
    assert.deepEqual(assignees.map((a: any) => a.name), ['Kiran', 'Zara']);
  });

  test('validation and duplicate names', async () => {
    assert.equal(await errorCode(CREATE, { i: { name: ' ', color: '#25d366' } }, A.token), 'BAD_USER_INPUT');
    assert.equal(await errorCode(CREATE, { i: { name: 'x'.repeat(51), color: '#25d366' } }, A.token), 'BAD_USER_INPUT');
    assert.equal(await errorCode(CREATE, { i: { name: 'Bad', color: 'blue' } }, A.token), 'BAD_USER_INPUT');
    assert.equal(await errorCode(CREATE, { i: { name: 'kiran', color: '#000000' } }, A.token), 'ASSIGNEE_EXISTS');
    assert.equal(await errorCode(UPDATE, { id: zara.id, i: { name: 'Kiran' } }, A.token), 'ASSIGNEE_EXISTS');
    await ok(CREATE, { i: { name: 'Kiran', color: '#000000' } }, B.token); // fine in another workspace
  });

  test('assign, reassign and unassign (one assignee per conversation)', async () => {
    let c = (await ok(ASSIGN, { c: ids[0], a: kiran.id }, A.token)).assignConversation;
    assert.deepEqual(c.assignee, { id: kiran.id, name: 'Kiran', color: '#34b7f1' });
    c = (await ok(ASSIGN, { c: ids[0], a: zara.id }, A.token)).assignConversation;
    assert.equal(c.assignee.name, 'Zara');
    await ok(ASSIGN, { c: ids[1], a: kiran.id }, A.token);
    await ok(ASSIGN, { c: ids[2], a: kiran.id }, A.token);
    c = (await ok(ASSIGN, { c: ids[2], a: null }, A.token)).assignConversation;
    assert.equal(c.assignee, null);
    const { assignees } = await ok(`{ assignees { name conversationCount } }`, undefined, A.token);
    assert.deepEqual(assignees, [
      { name: 'Kiran', conversationCount: 1 },
      { name: 'Zara', conversationCount: 1 },
    ]);
  });

  test('conversations can be filtered by assignee', async () => {
    const list = async (vars: object) => (await ok(BY_ASSIGNEE, vars, A.token)).conversations.nodes.map((c: any) => c.id);
    assert.deepEqual(await list({ assignee: zara.id }), [ids[0]]);
    assert.deepEqual(await list({ assignee: kiran.id }), [ids[1]]);
    const unassigned = await list({ assignee: 'unassigned' });
    assert.ok(unassigned.includes(ids[2]) && !unassigned.includes(ids[0]) && !unassigned.includes(ids[1]));
    assert.equal((await list({})).length, ids.length);
  });

  test('editing an assignee updates it on conversations', async () => {
    const updated = (await ok(UPDATE, { id: kiran.id, i: { name: 'Kiran S', color: null } }, A.token)).updateAssignee;
    assert.deepEqual([updated.name, updated.color, updated.conversationCount], ['Kiran S', '#34b7f1', 1]);
    const { conversation } = await ok(`query($id: ID!) { conversation(id: $id) { assignee { name } } }`, { id: ids[1] }, A.token);
    assert.deepEqual(conversation.assignee, { name: 'Kiran S' });
  });

  test('workspace isolation for assignees', async () => {
    assert.deepEqual((await ok(`{ assignees { name } }`, undefined, B.token)).assignees, [{ name: 'Kiran' }]);
    assert.equal(await errorCode(UPDATE, { id: kiran.id, i: { name: 'hack' } }, B.token), 'NOT_FOUND');
    assert.equal(await errorCode(DELETE, { id: kiran.id }, B.token), 'NOT_FOUND');
    assert.equal(await errorCode(ASSIGN, { c: ids[0], a: kiran.id }, B.token), 'NOT_FOUND');
    const bAssignee = (await prisma.assignee.findFirst({ where: { workspaceId: B.workspaceId } }))!;
    assert.equal(await errorCode(ASSIGN, { c: ids[0], a: bAssignee.id }, A.token), 'NOT_FOUND');
    assert.equal((await ok(BY_ASSIGNEE, { assignee: kiran.id }, B.token)).conversations.nodes.length, 0);
  });

  test('deleting an assignee unassigns their conversations', async () => {
    assert.equal((await ok(DELETE, { id: kiran.id }, A.token)).deleteAssignee, kiran.id);
    const { conversation } = await ok(`query($id: ID!) { conversation(id: $id) { assignee { name } } }`, { id: ids[1] }, A.token);
    assert.equal(conversation.assignee, null);
    assert.equal(await errorCode(DELETE, { id: kiran.id }, A.token), 'NOT_FOUND');
    // Others keep theirs
    const other = await ok(`query($id: ID!) { conversation(id: $id) { assignee { name } } }`, { id: ids[0] }, A.token);
    assert.deepEqual(other.conversation.assignee, { name: 'Zara' });
  });
});

describe('label permissions and colours', () => {
  const ME = `{ me { role canManageLabels } }`;
  const CREATE_LABEL = `mutation($i: CreateLabelInput!) { createLabel(input: $i) { id name color } }`;
  const UPDATE_LABEL = `mutation($id: ID!, $i: UpdateLabelInput!) { updateLabel(id: $id, input: $i) { id color } }`;
  const CREATE_ASSIGNEE = `mutation($i: CreateAssigneeInput!) { createAssignee(input: $i) { id color } }`;
  const UPDATE_ASSIGNEE = `mutation($id: ID!, $i: UpdateAssigneeInput!) { updateAssignee(id: $id, input: $i) { id color } }`;
  const GRANT = `mutation($u: ID!, $v: Boolean!) { setLabelPermission(userId: $u, canManageLabels: $v) { userId role canManageLabels } }`;
  let agent: { id: string; token: string };
  let label: any;
  let assignee: any;
  let conversationId: string;

  before(async () => {
    // An agent in workspace A without label-management permission (there's no invite flow yet)
    const email = `e2e-agent2-${run}@example.com`;
    const user = await prisma.user.create({
      data: { name: 'Agent', email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role: 'agent', workspaceId: A.workspaceId } } },
    });
    created.userIds.push(user.id);
    const { login } = await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } });
    agent = { id: user.id, token: login.token };
    conversationId = (await ok(CONVERSATIONS, { first: 1 }, A.token)).conversations.nodes[0].id;
  });

  test('me reports role and permission', async () => {
    assert.deepEqual((await ok(ME, undefined, A.token)).me, { role: 'owner', canManageLabels: true });
    assert.deepEqual((await ok(ME, undefined, agent.token)).me, { role: 'agent', canManageLabels: false });
  });

  test('owner can save preset and custom HEX colours; invalid HEX is rejected', async () => {
    label = (await ok(CREATE_LABEL, { i: { name: 'Custom', color: '#A1B2C3' } }, A.token)).createLabel;
    assert.equal(label.color, '#a1b2c3');
    assert.equal((await ok(UPDATE_LABEL, { id: label.id, i: { color: '#25d366' } }, A.token)).updateLabel.color, '#25d366');
    for (const color of ['#12345', '123456', '#GGGGGG', '#abc', '#1234567', 'red', ''])
      assert.equal(await errorCode(UPDATE_LABEL, { id: label.id, i: { color } }, A.token), 'BAD_USER_INPUT', color);
    assignee = (await ok(CREATE_ASSIGNEE, { i: { name: 'Custom person', color: '#0F0F0F' } }, A.token)).createAssignee;
    assert.equal(assignee.color, '#0f0f0f');
    assert.equal(await errorCode(UPDATE_ASSIGNEE, { id: assignee.id, i: { color: '#xyzxyz' } }, A.token), 'BAD_USER_INPUT');
    // Persisted
    assert.equal((await prisma.label.findUnique({ where: { id: label.id } }))!.color, '#25d366');
  });

  test('agents without permission can use labels but not change them, and cannot assign chats to others', async () => {
    const add = `mutation($c: ID!, $l: ID!) { addConversationLabel(conversationId: $c, labelId: $l) { labels { id color } } }`;
    const added = (await ok(add, { c: conversationId, l: label.id }, agent.token)).addConversationLabel.labels;
    assert.equal(added.find((l: any) => l.id === label.id).color, '#25d366');
    const assign = `mutation($c: ID!, $a: ID) { assignConversation(conversationId: $c, assigneeId: $a) { assignee { color } } }`;
    assert.equal(await errorCode(assign, { c: conversationId, a: assignee.id }, agent.token), 'FORBIDDEN'); // supervisors/admins only
    assert.deepEqual((await ok(assign, { c: conversationId, a: assignee.id }, A.token)).assignConversation.assignee, { color: '#0f0f0f' });
    // Same colours everywhere they read labels
    const { labels } = await ok(`{ labels { id color } }`, undefined, agent.token);
    assert.equal(labels.find((l: any) => l.id === label.id).color, '#25d366');

    assert.equal(await errorCode(CREATE_LABEL, { i: { name: 'Nope', color: '#000000' } }, agent.token), 'FORBIDDEN');
    assert.equal(await errorCode(UPDATE_LABEL, { id: label.id, i: { color: '#000000' } }, agent.token), 'FORBIDDEN');
    assert.equal(await errorCode(UPDATE_LABEL, { id: label.id, i: { name: 'Renamed' } }, agent.token), 'FORBIDDEN');
    assert.equal(await errorCode(`mutation($id: ID!) { deleteLabel(id: $id) }`, { id: label.id }, agent.token), 'FORBIDDEN');
    assert.equal(await errorCode(CREATE_ASSIGNEE, { i: { name: 'Nope', color: '#000000' } }, agent.token), 'FORBIDDEN');
    assert.equal(await errorCode(UPDATE_ASSIGNEE, { id: assignee.id, i: { color: '#000000' } }, agent.token), 'FORBIDDEN');
    assert.equal(await errorCode(`mutation($id: ID!) { deleteAssignee(id: $id) }`, { id: assignee.id }, agent.token), 'FORBIDDEN');
    // Nothing changed
    assert.equal((await prisma.label.findUnique({ where: { id: label.id } }))!.color, '#25d366');
  });

  test('only owners/admins grant permission; a granted agent can then manage labels', async () => {
    const owner = (await ok(`{ me { user { id } } }`, undefined, A.token)).me.user.id;
    assert.equal(await errorCode(GRANT, { u: agent.id, v: true }, agent.token), 'FORBIDDEN');
    assert.equal(await errorCode(GRANT, { u: owner, v: true }, B.token), 'NOT_FOUND');
    assert.deepEqual((await ok(GRANT, { u: agent.id, v: true }, A.token)).setLabelPermission, { userId: agent.id, role: 'agent', canManageLabels: true });
    assert.equal((await ok(ME, undefined, agent.token)).me.canManageLabels, true);
    assert.equal((await ok(UPDATE_LABEL, { id: label.id, i: { color: '#ff3b30' } }, agent.token)).updateLabel.color, '#ff3b30');
    await ok(GRANT, { u: agent.id, v: false }, A.token);
    assert.equal(await errorCode(UPDATE_LABEL, { id: label.id, i: { color: '#000000' } }, agent.token), 'FORBIDDEN');
  });
});

describe('edit and delete messages', () => {
  const FIELDS = 'id body type direction sentById editedAt deletedAt version createdAt';
  const EDIT = `mutation($i: EditMessageInput!) { editMessage(input: $i) { ${FIELDS} } }`;
  const DELETE = `mutation($id: ID!, $v: Int) { deleteMessage(messageId: $id, version: $v) { ${FIELDS} } }`;
  let owner: string;
  let agent: { id: string; token: string };
  let conversationId: string;
  const msg = (data: object) =>
    prisma.message.create({ data: { conversationId, direction: 'out', type: 'text', body: 'x', status: 'sent', ...data } as any });

  before(async () => {
    owner = (await ok(`{ me { user { id } } }`, undefined, A.token)).me.user.id;
    const email = `e2e-msg-agent-${run}@example.com`;
    const user = await prisma.user.create({
      data: { name: 'Msg Agent', email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role: 'agent', workspaceId: A.workspaceId } } },
    });
    created.userIds.push(user.id);
    const { login } = await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } });
    agent = { id: user.id, token: login.token };
    conversationId = (await ok(CONVERSATIONS, { first: 1 }, A.token)).conversations.nodes[0].id;
  });

  test('sending records who sent the message', async () => {
    // Workspace B with a (fake) connected number and an open 24h window: Meta rejects it, but the row is saved
    await prisma.whatsAppAccount.create({
      data: { workspaceId: B.workspaceId, wabaId: 'w', phoneNumberId: `pn-msg-${run}`, accessToken: 'fake-token-e2e' },
    });
    await ok(SIMULATE, { i: { waId: '919555555555', body: 'hi' } }, B.token);
    const [c] = (await ok(CONVERSATIONS, {}, B.token)).conversations.nodes;
    const bUser = (await ok(`{ me { user { id } } }`, undefined, B.token)).me.user.id;
    const sent = (await ok(`mutation($i: SendTextInput!) { sendTextMessage(input: $i) { ${FIELDS} } }`, { i: { conversationId: c.id, body: 'from B' } }, B.token)).sendTextMessage;
    assert.equal(sent.sentById, bUser);
    assert.equal(sent.version, 0);
    assert.equal(sent.editedAt, null);
    await prisma.whatsAppAccount.delete({ where: { workspaceId: B.workspaceId } }); // later tests expect B unconnected
  });

  test('edit your own message: new text, Edited timestamp, version bump, history kept', async () => {
    const m = await msg({ body: 'Your order ships today', sentById: agent.id });
    const edited = (await ok(EDIT, { i: { messageId: m.id, body: '  Your order ships tomorrow ', version: 0 } }, agent.token)).editMessage;
    assert.equal(edited.body, 'Your order ships tomorrow');
    assert.ok(edited.editedAt);
    assert.equal(edited.version, 1);
    assert.equal(new Date(edited.createdAt).getTime(), m.createdAt.getTime()); // original send time kept
    const revisions = await prisma.messageRevision.findMany({ where: { messageId: m.id } });
    assert.deepEqual(revisions.map((r) => [r.action, r.body, r.userId]), [['edit', 'Your order ships today', agent.id]]);
    // Persisted and visible to everyone in the workspace
    const { messages } = await ok(MESSAGES, { id: conversationId, first: 100 }, A.token);
    assert.equal(messages.nodes.find((x: any) => x.id === m.id).body, 'Your order ships tomorrow');
  });

  test('concurrent edits: a stale version is rejected and nothing is overwritten', async () => {
    const m = await msg({ body: 'v0', sentById: agent.id });
    const [a, b] = await Promise.all([
      gql(EDIT, { i: { messageId: m.id, body: 'edit A', version: 0 } }, agent.token),
      gql(EDIT, { i: { messageId: m.id, body: 'edit B', version: 0 } }, A.token),
    ]);
    const wins = [a, b].filter((r) => !r.errors);
    const losses = [a, b].filter((r) => r.errors);
    assert.equal(wins.length, 1);
    assert.equal(losses[0].errors![0].extensions?.code, 'EDIT_CONFLICT');
    const row = (await prisma.message.findUnique({ where: { id: m.id } }))!;
    assert.equal(row.version, 1);
    assert.equal(row.body, wins[0].data.editMessage.body);
    assert.equal(await errorCode(EDIT, { i: { messageId: m.id, body: 'late', version: 0 } }, agent.token), 'EDIT_CONFLICT');
  });

  test('edit validation', async () => {
    const m = await msg({ body: 'abc', sentById: agent.id });
    assert.equal(await errorCode(EDIT, { i: { messageId: m.id, body: '   ', version: 0 } }, agent.token), 'BAD_USER_INPUT');
    assert.equal(await errorCode(EDIT, { i: { messageId: m.id, body: 'x'.repeat(4097), version: 0 } }, agent.token), 'BAD_USER_INPUT');
    const template = await msg({ type: 'template', body: '[template] hello_world', sentById: agent.id });
    assert.equal(await errorCode(EDIT, { i: { messageId: template.id, body: 'x', version: 0 } }, agent.token), 'NOT_EDITABLE');
    // Unchanged text is a no-op
    const same = (await ok(EDIT, { i: { messageId: m.id, body: 'abc', version: 0 } }, agent.token)).editMessage;
    assert.deepEqual([same.version, same.editedAt], [0, null]);
  });

  test('permissions: agents only their own; customers\' messages never; admins any sent message', async () => {
    const ownersMsg = await msg({ body: 'owner wrote', sentById: owner });
    const legacy = await msg({ body: 'sent before sender tracking' });
    const inbound = await prisma.message.create({ data: { conversationId, direction: 'in', type: 'text', body: 'customer', status: 'received' } });
    for (const id of [ownersMsg.id, legacy.id]) {
      assert.equal(await errorCode(EDIT, { i: { messageId: id, body: 'hack', version: 0 } }, agent.token), 'FORBIDDEN');
      assert.equal(await errorCode(DELETE, { id }, agent.token), 'FORBIDDEN');
    }
    for (const token of [agent.token, A.token]) {
      assert.equal(await errorCode(EDIT, { i: { messageId: inbound.id, body: 'hack', version: 0 } }, token), 'FORBIDDEN');
      assert.equal(await errorCode(DELETE, { id: inbound.id }, token), 'FORBIDDEN');
    }
    // Owner (admin policy) may edit an older message with no recorded sender, and another agent's
    assert.equal((await ok(EDIT, { i: { messageId: legacy.id, body: 'fixed typo', version: 0 } }, A.token)).editMessage.body, 'fixed typo');
    const agentsMsg = await msg({ body: 'agent wrote', sentById: agent.id });
    assert.ok((await ok(DELETE, { id: agentsMsg.id }, A.token)).deleteMessage.deletedAt);
    // Other workspaces can't even see them
    assert.equal(await errorCode(EDIT, { i: { messageId: ownersMsg.id, body: 'x', version: 0 } }, B.token), 'NOT_FOUND');
    assert.equal(await errorCode(DELETE, { id: ownersMsg.id }, B.token), 'NOT_FOUND');
    assert.equal(await errorCode(DELETE, { id: 'nope' }, A.token), 'NOT_FOUND');
    // Nothing changed for the refused attempts
    assert.equal((await prisma.message.findUnique({ where: { id: ownersMsg.id } }))!.body, 'owner wrote');
    assert.equal((await prisma.message.findUnique({ where: { id: inbound.id } }))!.body, 'customer');
  });

  test('delete for everyone keeps the row, hides the text everywhere, and is idempotent', async () => {
    const m = await msg({ body: 'secret discount code', sentById: agent.id });
    const deleted = (await ok(DELETE, { id: m.id, v: 0 }, agent.token)).deleteMessage;
    assert.ok(deleted.deletedAt);
    assert.equal(deleted.body, '');
    assert.equal(deleted.version, 1);
    const row = (await prisma.message.findUnique({ where: { id: m.id } }))!;
    assert.deepEqual([row.body, row.deletedById, !!row.deletedAt], ['', agent.id, true]);
    assert.deepEqual(
      (await prisma.messageRevision.findMany({ where: { messageId: m.id } })).map((r) => [r.action, r.body]),
      [['delete', 'secret discount code']],
    );
    // Still in the conversation (layout preserved), without its text
    const { messages } = await ok(MESSAGES, { id: conversationId, first: 100 }, A.token);
    const listed = messages.nodes.find((x: any) => x.id === m.id);
    assert.equal(listed.body, '');
    assert.equal((await rest('GET', `/inbox/conversations/${conversationId}/messages`, A.token)).body.messages.find((x: any) => x.id === m.id).body, '');
    // Again: same result, no new history
    const again = (await ok(DELETE, { id: m.id }, A.token)).deleteMessage;
    assert.equal(again.version, 1);
    assert.equal(await prisma.messageRevision.count({ where: { messageId: m.id } }), 1);
    // Can't be edited back, and a stale delete is a conflict
    assert.equal(await errorCode(EDIT, { i: { messageId: m.id, body: 'undo', version: 1 } }, agent.token), 'MESSAGE_DELETED');
    const other = await msg({ body: 'y', sentById: agent.id });
    await ok(EDIT, { i: { messageId: other.id, body: 'y2', version: 0 } }, agent.token);
    assert.equal(await errorCode(DELETE, { id: other.id, v: 0 }, agent.token), 'EDIT_CONFLICT');
  });

  test('undo a delete: original text, edit mark and send time come back', async () => {
    const RESTORE = `mutation($id: ID!, $v: Int!) { restoreMessage(messageId: $id, version: $v) { ${FIELDS} } }`;
    const m = await msg({ body: 'v1', sentById: agent.id });
    await ok(EDIT, { i: { messageId: m.id, body: 'Pickup at 5pm', version: 0 } }, agent.token);
    const deleted = (await ok(DELETE, { id: m.id, v: 1 }, agent.token)).deleteMessage;
    // Only the person who deleted it may undo, and only from the version they deleted
    assert.equal(await errorCode(RESTORE, { id: m.id, v: deleted.version }, A.token), 'FORBIDDEN');
    assert.equal(await errorCode(RESTORE, { id: m.id, v: deleted.version }, B.token), 'NOT_FOUND');
    assert.equal(await errorCode(RESTORE, { id: m.id, v: 0 }, agent.token), 'EDIT_CONFLICT');
    const restored = (await ok(RESTORE, { id: m.id, v: deleted.version }, agent.token)).restoreMessage;
    assert.equal(restored.body, 'Pickup at 5pm');
    assert.equal(restored.deletedAt, null);
    assert.ok(restored.editedAt);
    assert.equal(restored.version, 3);
    assert.equal(new Date(restored.createdAt).getTime(), m.createdAt.getTime());
    const row = (await prisma.message.findUnique({ where: { id: m.id } }))!;
    assert.deepEqual([row.body, row.deletedAt, row.deletedById], ['Pickup at 5pm', null, null]);
    assert.deepEqual(
      (await prisma.messageRevision.findMany({ where: { messageId: m.id }, orderBy: { createdAt: 'asc' } })).map((r) => r.action),
      ['edit', 'delete', 'restore'],
    );
    // Visible to everyone again
    const { messages } = await ok(MESSAGES, { id: conversationId, first: 100 }, A.token);
    assert.equal(messages.nodes.find((x: any) => x.id === m.id).body, 'Pickup at 5pm');
    // Not deleted any more, so a second undo is refused
    assert.equal(await errorCode(RESTORE, { id: m.id, v: 3 }, agent.token), 'NOT_DELETED');
  });

  test('undo is only possible shortly after deleting', async () => {
    const RESTORE = `mutation($id: ID!, $v: Int!) { restoreMessage(messageId: $id, version: $v) { id } }`;
    const m = await msg({ body: 'old news', sentById: agent.id });
    const deleted = (await ok(DELETE, { id: m.id }, agent.token)).deleteMessage;
    await prisma.message.update({ where: { id: m.id }, data: { deletedAt: new Date(Date.now() - 61_000) } });
    assert.equal(await errorCode(RESTORE, { id: m.id, v: deleted.version }, agent.token), 'UNDO_EXPIRED');
    assert.equal((await prisma.message.findUnique({ where: { id: m.id } }))!.body, '');
  });
});

describe('close and reopen chats', () => {
  const STATUS = 'id status closedAt closedById unread contact { waId } labels { id } assignee { id } lastMessage { body }';
  const CLOSE = `mutation($id: ID!) { closeConversation(id: $id) { ${STATUS} } }`;
  const REOPEN = `mutation($id: ID!) { reopenConversation(id: $id) { ${STATUS} } }`;
  const COUNTS = `{ conversationCounts { open closed closedWithUnread } }`;
  const BY_STATUS = `query($s: String) { conversations(status: $s) { nodes { id status } } }`;
  let me: string;
  let target: any;

  before(async () => {
    me = (await ok(`{ me { user { id } } }`, undefined, A.token)).me.user.id;
    await ok(SIMULATE, { i: { waId: '916666666666', name: 'Closer', body: 'Thanks, solved!' } }, A.token);
    target = (await ok(`{ conversations { nodes { ${STATUS} } } }`, undefined, A.token)).conversations.nodes.find(
      (c: any) => c.contact.waId === '916666666666',
    );
    // Give it a label so we can check closing keeps it
    const label = (await ok(`mutation { createLabel(input: { name: "Closing test", color: "#25d366" }) { id } }`, undefined, A.token)).createLabel;
    await ok(`mutation($c: ID!, $l: ID!) { addConversationLabel(conversationId: $c, labelId: $l) { id } }`, { c: target.id, l: label.id }, A.token);
    await ok(`mutation($id: ID!) { markConversationRead(id: $id) { id } }`, { id: target.id }, A.token);
  });

  test('new chats are open', async () => {
    assert.equal(target.status, 'open');
    assert.equal(target.closedAt, null);
  });

  test('close keeps messages, labels and customer details; idempotent', async () => {
    const before = await prisma.message.count({ where: { conversationId: target.id } });
    const closed = (await ok(CLOSE, { id: target.id }, A.token)).closeConversation;
    assert.deepEqual([closed.status, closed.closedById, !!closed.closedAt], ['closed', me, true]);
    assert.equal(closed.labels.length, 1);
    assert.equal(closed.contact.waId, '916666666666');
    assert.equal(closed.lastMessage.body, 'Thanks, solved!');
    assert.equal(await prisma.message.count({ where: { conversationId: target.id } }), before);
    const again = (await ok(CLOSE, { id: target.id }, A.token)).closeConversation;
    assert.equal(again.closedAt, closed.closedAt);
    const row = (await prisma.conversation.findUnique({ where: { id: target.id } }))!;
    assert.deepEqual([row.status, row.closedById], ['closed', me]);
  });

  test('Open and Closed filters, combined with other filters, and counts', async () => {
    const open = (await ok(BY_STATUS, { s: 'open' }, A.token)).conversations.nodes;
    const closed = (await ok(BY_STATUS, { s: 'closed' }, A.token)).conversations.nodes;
    assert.ok(!open.some((c: any) => c.id === target.id));
    assert.deepEqual(closed.map((c: any) => c.id), [target.id]);
    assert.equal((await ok(BY_STATUS, {}, A.token)).conversations.nodes.length, open.length + 1);
    assert.equal(await errorCode(BY_STATUS, { s: 'resolved' }, A.token), 'BAD_USER_INPUT');
    const counts = (await ok(COUNTS, undefined, A.token)).conversationCounts;
    assert.deepEqual(counts, { open: open.length, closed: 1, closedWithUnread: 0 });
    // B's counts don't include A's chats
    assert.equal((await ok(COUNTS, undefined, B.token)).conversationCounts.closed, 0);
  });

  test("a customer message to a closed chat is saved and counted, and doesn't reopen it", async () => {
    await ok(SIMULATE, { i: { waId: '916666666666', body: 'One more question' } }, A.token);
    const row = (await prisma.conversation.findUnique({ where: { id: target.id } }))!;
    assert.deepEqual([row.status, row.unread], ['closed', 1]);
    const { messages } = await ok(MESSAGES, { id: target.id }, A.token);
    assert.equal(messages.nodes.at(-1).body, 'One more question');
    assert.equal((await ok(COUNTS, undefined, A.token)).conversationCounts.closedWithUnread, 1);
  });

  test("can't reply to a closed chat", async () => {
    // A has a (fake) number connected by now? Connect one only for this check if needed
    const had = await prisma.whatsAppAccount.findUnique({ where: { workspaceId: A.workspaceId } });
    if (!had) await prisma.whatsAppAccount.create({ data: { workspaceId: A.workspaceId, wabaId: 'w', phoneNumberId: `pn-close-${run}`, accessToken: 'fake' } });
    const before = await prisma.message.count({ where: { conversationId: target.id } });
    assert.equal(
      await errorCode(`mutation($i: SendTextInput!) { sendTextMessage(input: $i) { id } }`, { i: { conversationId: target.id, body: 'hi' } }, A.token),
      'CONVERSATION_CLOSED',
    );
    assert.equal(await prisma.message.count({ where: { conversationId: target.id } }), before);
    if (!had) await prisma.whatsAppAccount.delete({ where: { workspaceId: A.workspaceId } });
  });

  test('other workspaces cannot close, reopen or see it', async () => {
    assert.equal(await errorCode(REOPEN, { id: target.id }, B.token), 'NOT_FOUND');
    assert.equal(await errorCode(CLOSE, { id: target.id }, B.token), 'NOT_FOUND');
    assert.equal(await errorCode(CLOSE, { id: 'nope' }, A.token), 'NOT_FOUND');
    assert.equal((await prisma.conversation.findUnique({ where: { id: target.id } }))!.status, 'closed');
  });

  test('reopen clears the closed fields and keeps everything else', async () => {
    const reopened = (await ok(REOPEN, { id: target.id }, A.token)).reopenConversation;
    assert.deepEqual([reopened.status, reopened.closedAt, reopened.closedById], ['open', null, null]);
    assert.equal(reopened.labels.length, 1);
    assert.equal(reopened.unread, 1);
    assert.equal(reopened.lastMessage.body, 'One more question');
    assert.ok((await ok(BY_STATUS, { s: 'open' }, A.token)).conversations.nodes.some((c: any) => c.id === target.id));
  });
});

describe('sender names', () => {
  const LIST = `query($id: ID!) { messages(conversationId: $id, first: 100) { nodes { id body direction sentById senderName deletedAt editedAt } } }`;
  let conversationId: string;
  let ownerId: string;
  let second: { id: string; token: string };

  before(async () => {
    ownerId = (await ok(`{ me { user { id } } }`, undefined, A.token)).me.user.id;
    await ok(SIMULATE, { i: { waId: '917777777777', name: 'Meena Customer', body: 'Hello from Meena' } }, A.token);
    conversationId = (await ok(CONVERSATIONS, {}, A.token)).conversations.nodes.find((c: any) => c.contact.waId === '917777777777').id;
    const email = `e2e-sender-${run}@example.com`;
    const user = await prisma.user.create({
      data: { name: 'Second Agent', email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role: 'agent', workspaceId: A.workspaceId } } },
    });
    created.userIds.push(user.id);
    second = { id: user.id, token: (await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } })).login.token };
    const out = (data: object) => prisma.message.create({ data: { conversationId, direction: 'out', type: 'text', status: 'sent', ...data } as any });
    await out({ body: 'Owner reply', sentById: ownerId });
    await out({ body: 'Second agent reply', sentById: second.id });
    await out({ body: 'Sent before sender tracking' });
  });

  test('customer, each agent, and older messages get the right name from the database', async () => {
    const nodes = (await ok(LIST, { id: conversationId }, A.token)).messages.nodes;
    const byBody = (b: string) => nodes.find((n: any) => n.body === b);
    assert.equal(byBody('Hello from Meena').senderName, 'Meena Customer');
    assert.equal(byBody('Owner reply').senderName, 'a');
    assert.equal(byBody('Second agent reply').senderName, 'Second Agent');
    assert.equal(byBody('Sent before sender tracking').senderName, null);
    // Same names for every agent looking at the chat
    const asSecond = (await ok(LIST, { id: conversationId }, second.token)).messages.nodes;
    assert.deepEqual(asSecond.map((n: any) => n.senderName), nodes.map((n: any) => n.senderName));
  });

  test('a customer without a saved name shows their number', async () => {
    await prisma.contact.updateMany({ where: { workspaceId: A.workspaceId, waId: '917777777777' }, data: { name: null } });
    const nodes = (await ok(LIST, { id: conversationId }, A.token)).messages.nodes;
    assert.equal(nodes.find((n: any) => n.body === 'Hello from Meena').senderName, '+917777777777');
  });

  test('edits and deletes keep the sender', async () => {
    const nodes = (await ok(LIST, { id: conversationId }, second.token)).messages.nodes;
    const mine = nodes.find((n: any) => n.body === 'Second agent reply');
    const edited = (await ok(`mutation($i: EditMessageInput!) { editMessage(input: $i) { senderName sentById } }`, { i: { messageId: mine.id, body: 'Second agent reply (edited)', version: 0 } }, second.token)).editMessage;
    assert.deepEqual(edited, { senderName: 'Second Agent', sentById: second.id });
    // Deleted by the owner: still shows who originally sent it
    const deleted = (await ok(`mutation($id: ID!) { deleteMessage(messageId: $id) { senderName sentById body deletedAt } }`, { id: mine.id }, A.token)).deleteMessage;
    assert.deepEqual([deleted.senderName, deleted.sentById, deleted.body, !!deleted.deletedAt], ['Second Agent', second.id, '', true]);
  });

  test("clients can't choose the sender", async () => {
    const r = await gql(`mutation { sendTextMessage(input: { conversationId: "${conversationId}", body: "x", senderName: "CEO", sentById: "${second.id}" }) { id } }`, undefined, A.token);
    assert.ok(r.errors?.length);
    assert.match(r.errors![0].message, /not defined by type "SendTextInput"/);
    assert.equal(await prisma.message.count({ where: { conversationId, body: 'x' } }), 0);
  });
});

describe('workspaces', () => {
  const LIST = `{ workspaces { id name role } }`;
  const CREATE = `mutation($n: String!) { createWorkspace(name: $n) { token user { id } workspace { id name } } }`;
  const SWITCH = `mutation($id: ID!) { switchWorkspace(id: $id) { token workspace { id name } } }`;
  let second: { id: string; token: string };

  test('lists only the workspaces you belong to', async () => {
    const { workspaces } = await ok(LIST, undefined, A.token);
    assert.deepEqual(workspaces.map((w: any) => [w.id, w.role]), [[A.workspaceId, 'owner']]);
  });

  test('create: you become owner and get a token for the new, empty workspace', async () => {
    const r = (await ok(CREATE, { n: '  Second branch ' }, A.token)).createWorkspace;
    created.workspaceIds.push(r.workspace.id);
    second = { id: r.workspace.id, token: r.token };
    assert.equal(r.workspace.name, 'Second branch');
    const me = (await ok(`{ me { workspace { id } role } }`, undefined, r.token)).me;
    assert.deepEqual([me.workspace.id, me.role], [r.workspace.id, 'owner']);
    // Separate data: nothing from workspace A shows up
    assert.equal((await ok(CONVERSATIONS, {}, r.token)).conversations.nodes.length, 0);
    assert.equal((await ok(`{ labels { id } }`, undefined, r.token)).labels.length, 0);
    // Both workspaces listed, from either token
    for (const token of [A.token, r.token])
      assert.deepEqual((await ok(LIST, undefined, token)).workspaces.map((w: any) => w.name), ['a', 'Second branch']);
    assert.equal(await errorCode(CREATE, { n: '   ' }, A.token), 'BAD_USER_INPUT');
    assert.equal(await errorCode(CREATE, { n: 'x'.repeat(192) }, A.token), 'BAD_USER_INPUT');
  });

  test('switch back and forth between your own workspaces only', async () => {
    const back = (await ok(SWITCH, { id: A.workspaceId }, second.token)).switchWorkspace;
    assert.equal(back.workspace.id, A.workspaceId);
    assert.ok((await ok(CONVERSATIONS, {}, back.token)).conversations.nodes.length > 0);
    assert.equal((await ok(SWITCH, { id: second.id }, back.token)).switchWorkspace.workspace.name, 'Second branch');
    // Someone else's workspace, or a made-up id: not found, no token
    assert.equal(await errorCode(SWITCH, { id: B.workspaceId }, A.token), 'NOT_FOUND');
    assert.equal(await errorCode(SWITCH, { id: second.id }, B.token), 'NOT_FOUND');
    assert.equal(await errorCode(SWITCH, { id: 'nope' }, A.token), 'NOT_FOUND');
    assert.deepEqual((await ok(LIST, undefined, B.token)).workspaces.map((w: any) => w.id), [B.workspaceId]);
  });
});

describe('forgot password', () => {
  const REQUEST = `mutation($e: String!) { requestPasswordReset(email: $e) }`;
  const RESET = `mutation($i: ResetPasswordInput!) { resetPassword(input: $i) }`;
  const LOGIN = `mutation($i: LoginInput!) { login(input: $i) { token } }`;
  const sha = (t: string) => createHash('sha256').update(t).digest('hex');
  let user: { id: string; email: string; token: string };

  before(async () => {
    const r = await newWorkspace('reset');
    const id = (await ok(`{ me { user { id email } } }`, undefined, r.token)).me.user;
    user = { id: id.id, email: id.email, token: r.token };
  });

  test("unknown emails get the same answer and nothing is created", async () => {
    assert.equal((await ok(REQUEST, { e: `nobody-${run}@example.com` })).requestPasswordReset, true);
    assert.equal(await errorCode(REQUEST, { e: 'not-an-email' }), 'BAD_USER_INPUT');
  });

  test('a request stores only a hash, expires in ~30 minutes, and replaces older links', async () => {
    assert.equal((await ok(REQUEST, { e: user.email.toUpperCase() })).requestPasswordReset, true);
    const [row] = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    assert.match(row.tokenHash, /^[0-9a-f]{64}$/);
    const minutes = (row.expiresAt.getTime() - Date.now()) / 60000;
    assert.ok(minutes > 29 && minutes <= 30, `expires in ${minutes} min`);
    await ok(REQUEST, { e: user.email });
    const rows = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].tokenHash, row.tokenHash);
  });

  test('reset with a valid link: new password works, old one and old sessions stop working', async () => {
    const raw = `e2e-reset-token-${run}-abcdefghijklmnop`;
    await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });
    await prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha(raw), expiresAt: new Date(Date.now() + 60_000) } });
    // The session from before the reset still works right now
    await ok(`{ me { user { id } } }`, undefined, user.token);
    await new Promise((r) => setTimeout(r, 1100)); // tokens carry whole-second timestamps
    assert.equal(await errorCode(RESET, { i: { token: raw, password: 'short' } }), 'BAD_USER_INPUT');
    assert.equal((await ok(RESET, { i: { token: raw, password: 'brand-new-pass-1' } })).resetPassword, true);
    // Old password refused, new one accepted
    assert.equal(await errorCode(LOGIN, { i: { email: user.email, password: 'password123' } }), 'INVALID_CREDENTIALS');
    const fresh = (await ok(LOGIN, { i: { email: user.email, password: 'brand-new-pass-1' } })).login.token;
    assert.ok((await ok(`{ me { user { id } } }`, undefined, fresh)).me.user.id);
    // Sessions from before the reset are signed out everywhere (GraphQL and REST)
    assert.equal(await errorCode(`{ me { user { id } } }`, undefined, user.token), 'UNAUTHENTICATED');
    assert.equal((await rest('GET', '/inbox/conversations', user.token)).status, 401);
    // The link worked once
    assert.equal(await errorCode(RESET, { i: { token: raw, password: 'another-pass-2' } }), 'INVALID_RESET_TOKEN');
    assert.ok((await prisma.passwordResetToken.findFirst({ where: { tokenHash: sha(raw) } }))!.usedAt);
  });

  test('expired and made-up links are rejected', async () => {
    const raw = `e2e-expired-token-${run}-abcdefghijklmnop`;
    await prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha(raw), expiresAt: new Date(Date.now() - 1000) } });
    assert.equal(await errorCode(RESET, { i: { token: raw, password: 'brand-new-pass-3' } }), 'INVALID_RESET_TOKEN');
    assert.equal(await errorCode(RESET, { i: { token: 'x'.repeat(43), password: 'brand-new-pass-3' } }), 'INVALID_RESET_TOKEN');
    assert.equal(await errorCode(RESET, { i: { token: 'short', password: 'brand-new-pass-3' } }), 'BAD_USER_INPUT');
    // Password unchanged by the failed attempts
    await ok(LOGIN, { i: { email: user.email, password: 'brand-new-pass-1' } });
  });
});

describe('activity history and notifications', () => {
  const TIMELINE = `query($c: ID!) { conversationActivity(conversationId: $c) { type actorName contactName data } }`;
  const FEED = `{ notifications { unseen items { type actorId actorName contactName data } } }`;
  let ws: { token: string; workspaceId: string };
  let mate: { id: string; token: string };
  let me: string;
  let conv: string;

  before(async () => {
    ws = await newWorkspace('activity');
    me = (await ok(`{ me { user { id } } }`, undefined, ws.token)).me.user.id;
    const email = `e2e-activity-mate-${run}@example.com`;
    const user = await prisma.user.create({
      // Supervisor: Mate assigns chats to others below (agents can only take and release their own)
      data: { name: 'Mate', email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role: 'supervisor', workspaceId: ws.workspaceId } } },
    });
    created.userIds.push(user.id);
    mate = { id: user.id, token: (await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } })).login.token };
    await ok(SIMULATE, { i: { waId: '918888888888', name: 'Riya', body: 'Do you have 205/55 R16?' } }, ws.token);
    conv = (await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes[0].id;
  });

  test('each change is recorded once, with who did it; no-ops are not', async () => {
    const label = (await ok(`mutation { createLabel(input: { name: "Hot lead", color: "#ff3b30" }) { id } }`, undefined, ws.token)).createLabel;
    const assignee = (await ok(`mutation { createAssignee(input: { name: "Desk A", color: "#128c7e" }) { id } }`, undefined, ws.token)).createAssignee;
    const add = `mutation($c: ID!, $l: ID!) { addConversationLabel(conversationId: $c, labelId: $l) { id } }`;
    const assign = `mutation($c: ID!, $a: ID) { assignConversation(conversationId: $c, assigneeId: $a) { id } }`;
    await ok(add, { c: conv, l: label.id }, mate.token);
    await ok(add, { c: conv, l: label.id }, mate.token); // already there
    await ok(`mutation($c: ID!, $l: ID!) { removeConversationLabel(conversationId: $c, labelId: $l) { id } }`, { c: conv, l: label.id }, ws.token);
    await ok(assign, { c: conv, a: assignee.id }, mate.token);
    await ok(assign, { c: conv, a: assignee.id }, mate.token); // same assignee
    await ok(assign, { c: conv, a: null }, ws.token);
    await ok(`mutation($id: ID!) { closeConversation(id: $id) { id } }`, { id: conv }, mate.token);
    await ok(`mutation($id: ID!) { closeConversation(id: $id) { id } }`, { id: conv }, mate.token); // already closed
    await ok(`mutation($id: ID!) { reopenConversation(id: $id) { id } }`, { id: conv }, ws.token);
    const msg = await prisma.message.create({ data: { conversationId: conv, direction: 'out', type: 'text', body: 'Yes, in stock: private note 1234', status: 'sent', sentById: mate.id } });
    await ok(`mutation($i: EditMessageInput!) { editMessage(input: $i) { id } }`, { i: { messageId: msg.id, body: 'Yes, in stock', version: 0 } }, mate.token);
    const del = (await ok(`mutation($id: ID!) { deleteMessage(messageId: $id) { version } }`, { id: msg.id }, mate.token)).deleteMessage;
    await ok(`mutation($id: ID!) { deleteMessage(messageId: $id) { version } }`, { id: msg.id }, mate.token); // already deleted
    await ok(`mutation($id: ID!, $v: Int!) { restoreMessage(messageId: $id, version: $v) { id } }`, { id: msg.id, v: del.version }, mate.token);

    const timeline = (await ok(TIMELINE, { c: conv }, ws.token)).conversationActivity;
    assert.deepEqual(
      timeline.map((a: any) => [a.type, a.actorName]),
      [
        ['label_added', 'Mate'],
        ['label_removed', 'activity'],
        ['assigned', 'Mate'],
        ['unassigned', 'activity'],
        ['conversation_closed', 'Mate'],
        ['conversation_reopened', 'activity'],
        ['message_edited', 'Mate'],
        ['message_deleted', 'Mate'],
        ['message_restored', 'Mate'],
      ],
    );
    assert.deepEqual(JSON.parse(timeline[0].data), { label: 'Hot lead', color: '#ff3b30' });
    assert.deepEqual(JSON.parse(timeline[2].data), { assignee: 'Desk A', color: '#128c7e' });
    assert.deepEqual(JSON.parse(timeline[3].data), { assignee: 'Desk A' });
    assert.ok(timeline.every((a: any) => a.contactName === 'Riya'));
    // Customer messages aren't in the timeline (they're bubbles), and no message text is stored
    assert.ok(!timeline.some((a: any) => a.type === 'message_received'));
    const stored = await prisma.activityEvent.findMany({ where: { conversationId: conv } });
    assert.ok(!JSON.stringify(stored).includes('private note'));
  });

  test("the bell: others' actions and customer messages, not your own; unseen count resets", async () => {
    const mine = (await ok(FEED, undefined, ws.token)).notifications;
    assert.ok(mine.items.length > 0);
    assert.ok(mine.items.every((a: any) => a.actorId !== me));
    assert.ok(mine.items.some((a: any) => a.type === 'message_received' && a.actorId === null && JSON.parse(a.data).preview === 'Do you have 205/55 R16?'));
    assert.equal(mine.unseen, mine.items.length);
    const theirs = (await ok(FEED, undefined, mate.token)).notifications;
    assert.ok(theirs.items.every((a: any) => a.actorId !== mate.id));
    assert.equal((await ok(`mutation { markNotificationsSeen }`, undefined, ws.token)).markNotificationsSeen, true);
    assert.equal((await ok(FEED, undefined, ws.token)).notifications.unseen, 0);
    await ok(SIMULATE, { i: { waId: '918888888888', body: 'Price?' } }, ws.token);
    assert.equal((await ok(FEED, undefined, ws.token)).notifications.unseen, 1);
    // Marking seen is per person
    assert.ok((await ok(FEED, undefined, mate.token)).notifications.unseen > 1);
  });

  test('unread total and workspace isolation', async () => {
    assert.equal((await ok(`{ unreadTotal }`, undefined, ws.token)).unreadTotal, 2);
    await ok(`mutation($id: ID!) { markConversationRead(id: $id) { id } }`, { id: conv }, ws.token);
    assert.equal((await ok(`{ unreadTotal }`, undefined, ws.token)).unreadTotal, 0);
    assert.equal(await errorCode(TIMELINE, { c: conv }, B.token), 'NOT_FOUND');
    assert.ok(!(await ok(FEED, undefined, B.token)).notifications.items.some((a: any) => a.contactName === 'Riya'));
  });
});

describe('assignments: linked users, history, permissions and Socket.IO', () => {
  const ASSIGNEE = 'id name color userId conversationCount';
  const CREATE = `mutation($i: CreateAssigneeInput!) { createAssignee(input: $i) { ${ASSIGNEE} } }`;
  const UPDATE = `mutation($id: ID!, $i: UpdateAssigneeInput!) { updateAssignee(id: $id, input: $i) { ${ASSIGNEE} } }`;
  const ASSIGN = `mutation($c: ID!, $a: ID) { assignConversation(conversationId: $c, assigneeId: $a) { id assignee { id name userId } } }`;
  const MINE = `{ conversations(assignee: "me") { nodes { id } } }`;
  const TIMELINE = `query($c: ID!) { conversationActivity(conversationId: $c) { type actorName data } }`;
  type Agent = { id: string; token: string };
  type Listener = { socket: Socket; events: { event: string; data: any }[] };
  let ws: { token: string; workspaceId: string };
  let owner: Agent;
  let asha: Agent; // agent without label/assignee management
  let ravi: Agent;
  let sam: Agent; // supervisor: assigns and reassigns anyone
  let conv: string;
  let conv2: string;
  let deskAsha: any;
  let deskRavi: any;
  let nightShift: any;
  const sockets: Record<string, Listener> = {};

  async function newAgent(name: string, role = 'agent') {
    const email = `e2e-assign-${name.toLowerCase()}-${run}@example.com`;
    const user = await prisma.user.create({
      data: { name, email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role, workspaceId: ws.workspaceId } } },
    });
    created.userIds.push(user.id);
    const { login } = await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } });
    return { id: user.id, token: login.token as string };
  }

  async function listen(token: string): Promise<Listener> {
    const socket = connectSocket(API, { auth: { token }, transports: ['websocket'], forceNew: true });
    const events: Listener['events'] = [];
    socket.onAny((event, data) => events.push({ event, data }));
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => resolve());
      socket.on('connect_error', reject);
    });
    return { socket, events };
  }
  const received = (who: string, event: string) => sockets[who].events.filter((e) => e.event === event).map((e) => e.data);
  const resetEvents = () => Object.values(sockets).forEach((s) => (s.events.length = 0));
  const settle = () => new Promise((r) => setTimeout(r, 300)); // let socket events arrive
  const timeline = async (c: string) => (await ok(TIMELINE, { c }, owner.token)).conversationActivity;
  const mine = async (token: string) => (await ok(MINE, undefined, token)).conversations.nodes.map((c: any) => c.id);

  before(async () => {
    ws = await newWorkspace('assignflow');
    owner = { id: (await ok(`{ me { user { id } } }`, undefined, ws.token)).me.user.id, token: ws.token };
    asha = await newAgent('Asha');
    ravi = await newAgent('Ravi');
    sam = await newAgent('Sam', 'supervisor');
    await ok(SIMULATE, { i: { waId: '917777777771', name: 'Riya', body: 'Need 4 tyres' } }, ws.token);
    await ok(SIMULATE, { i: { waId: '917777777772', name: 'Kabir', body: 'Alignment?' } }, ws.token);
    const nodes = (await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes;
    conv = nodes.find((c: any) => c.contact.name === 'Riya').id;
    conv2 = nodes.find((c: any) => c.contact.name === 'Kabir').id;
    for (const [who, a] of Object.entries({ owner, asha, ravi })) sockets[who] = await listen(a.token);
  });

  after(() => Object.values(sockets).forEach((s) => s.socket.disconnect()));

  test('workspaceMembers lists everyone in the workspace by name, with email and role', async () => {
    const { workspaceMembers } = await ok(`{ workspaceMembers { id name email role } }`, undefined, asha.token);
    assert.deepEqual(
      workspaceMembers.map((m: any) => [m.name, m.role]),
      [['Asha', 'agent'], ['assignflow', 'owner'], ['Ravi', 'agent'], ['Sam', 'supervisor']],
    );
    assert.equal(workspaceMembers.find((m: any) => m.id === asha.id).email, `e2e-assign-asha-${run}@example.com`);
    assert.ok(!(await ok(`{ workspaceMembers { id } }`, undefined, B.token)).workspaceMembers.some((m: any) => m.id === asha.id));
  });

  test('link assignees to members: managers only, members of this workspace only, one assignee per person', async () => {
    assert.equal(await errorCode(CREATE, { i: { name: 'Asha', color: '#128c7e', userId: asha.id } }, asha.token), 'FORBIDDEN');
    deskAsha = (await ok(CREATE, { i: { name: 'Asha', color: '#128c7e', userId: asha.id } }, owner.token)).createAssignee;
    deskRavi = (await ok(CREATE, { i: { name: 'Ravi', color: '#5e5ce6', userId: ravi.id } }, owner.token)).createAssignee;
    nightShift = (await ok(CREATE, { i: { name: 'Night shift', color: '#c2410c' } }, owner.token)).createAssignee;
    assert.deepEqual([deskAsha.userId, deskRavi.userId, nightShift.userId], [asha.id, ravi.id, null]);

    const bUser = (await ok(`{ me { user { id } } }`, undefined, B.token)).me.user.id;
    assert.equal(await errorCode(CREATE, { i: { name: 'Outsider', color: '#000000', userId: bUser } }, owner.token), 'NOT_FOUND');
    assert.equal(await errorCode(CREATE, { i: { name: 'Asha 2', color: '#000000', userId: asha.id } }, owner.token), 'ASSIGNEE_USER_TAKEN');
    assert.equal(await errorCode(UPDATE, { id: deskRavi.id, i: { userId: asha.id } }, owner.token), 'ASSIGNEE_USER_TAKEN');
    assert.equal(await errorCode(UPDATE, { id: nightShift.id, i: { userId: ravi.id } }, asha.token), 'FORBIDDEN');

    // Leaving userId out (or sending other fields as null) keeps the link; userId: null unlinks
    let r = (await ok(UPDATE, { id: deskRavi.id, i: { color: '#5E5CE6', name: null } }, owner.token)).updateAssignee;
    assert.deepEqual([r.name, r.userId], ['Ravi', ravi.id]);
    r = (await ok(UPDATE, { id: deskRavi.id, i: { userId: null } }, owner.token)).updateAssignee;
    assert.equal(r.userId, null);
    r = (await ok(UPDATE, { id: deskRavi.id, i: { userId: ravi.id } }, owner.token)).updateAssignee;
    assert.equal(r.userId, ravi.id);
    const { assignees } = await ok(`{ assignees { name user { id name role } } }`, undefined, asha.token);
    assert.deepEqual(assignees.find((a: any) => a.name === 'Ravi').user, { id: ravi.id, name: 'Ravi', role: 'agent' });
    assert.equal(assignees.find((a: any) => a.name === 'Night shift').user, null);
  });

  test('agents take and release their own chats; supervisors assign, reassign and unassign; history names the previous assignee; no-ops record nothing', async () => {
    await ok(ASSIGN, { c: conv, a: deskAsha.id }, asha.token); // Asha takes the unassigned chat
    await ok(ASSIGN, { c: conv, a: nightShift.id }, sam.token);
    await ok(ASSIGN, { c: conv, a: nightShift.id }, sam.token); // already Night shift
    await ok(ASSIGN, { c: conv, a: deskAsha.id }, sam.token);
    const c = (await ok(ASSIGN, { c: conv, a: null }, asha.token)).assignConversation; // Asha releases it
    assert.equal(c.assignee, null);
    await ok(ASSIGN, { c: conv, a: null }, sam.token); // already unassigned

    const items = await timeline(conv);
    assert.deepEqual(
      items.map((a: any) => [a.type, a.actorName, JSON.parse(a.data)]),
      [
        ['assigned', 'Asha', { assignee: 'Asha', color: '#128c7e', assigneeUserId: asha.id }],
        ['reassigned', 'Sam', { assignee: 'Night shift', color: '#c2410c', previous: 'Asha' }],
        ['reassigned', 'Sam', { assignee: 'Asha', color: '#128c7e', previous: 'Night shift', assigneeUserId: asha.id }],
        ['unassigned', 'Asha', { assignee: 'Asha' }],
      ],
    );
  });

  test('Socket.IO: one conversation:assigned per real change; assignment:you only to the linked agent, never to yourself', async () => {
    resetEvents();
    await ok(ASSIGN, { c: conv, a: deskRavi.id }, owner.token);
    await settle();
    for (const who of ['owner', 'asha', 'ravi']) {
      const assigned = received(who, 'conversation:assigned');
      assert.equal(assigned.length, 1, `${who} should get exactly one conversation:assigned`);
      assert.deepEqual([assigned[0].conversationId, assigned[0].assignee.id, assigned[0].assignee.userId], [conv, deskRavi.id, ravi.id]);
    }
    assert.deepEqual(
      received('ravi', 'assignment:you').map((e) => [e.conversationId, e.actorName, e.contactName, e.assignee.name]),
      [[conv, 'assignflow', 'Riya', 'Ravi']],
    );
    assert.equal(received('owner', 'assignment:you').length, 0);
    assert.equal(received('asha', 'assignment:you').length, 0);
    assert.equal(received('owner', 'activity:new').filter((a) => a.type === 'reassigned' || a.type === 'assigned').length, 1);

    resetEvents();
    await ok(ASSIGN, { c: conv, a: deskRavi.id }, asha.token); // no change
    await settle();
    for (const who of ['owner', 'asha', 'ravi']) {
      assert.equal(received(who, 'conversation:assigned').length, 0);
      assert.equal(received(who, 'activity:new').length, 0);
    }

    resetEvents();
    await ok(ASSIGN, { c: conv2, a: deskRavi.id }, ravi.token); // to himself: no pop-up
    await ok(ASSIGN, { c: conv2, a: null }, owner.token); // unassign: nobody is "assigned"
    await settle();
    assert.equal(received('ravi', 'assignment:you').length, 0);
    assert.deepEqual(received('asha', 'conversation:assigned').map((e) => e.assignee?.id ?? null), [deskRavi.id, null]);
  });

  test('Socket.IO: assignment:removed tells only the agent a chat was taken from, unless they did it', async () => {
    // conv is assigned to Ravi (from the previous test)
    resetEvents();
    await ok(ASSIGN, { c: conv, a: deskAsha.id }, owner.token); // reassign Ravi -> Asha
    await settle();
    assert.deepEqual(
      received('ravi', 'assignment:removed').map((e) => [e.conversationId, e.previous, e.assignee?.name, e.actorName, e.contactName]),
      [[conv, 'Ravi', 'Asha', 'assignflow', 'Riya']],
    );
    assert.equal(received('asha', 'assignment:you').length, 1);
    assert.equal(received('asha', 'assignment:removed').length, 0);
    assert.equal(received('owner', 'assignment:removed').length, 0);

    resetEvents();
    await ok(ASSIGN, { c: conv, a: null }, asha.token); // Asha unassigns herself: nobody to tell
    await ok(ASSIGN, { c: conv, a: deskRavi.id }, owner.token);
    await ok(ASSIGN, { c: conv, a: null }, owner.token); // owner unassigns Ravi
    await ok(ASSIGN, { c: conv, a: nightShift.id }, owner.token); // from nobody: nothing removed
    await ok(ASSIGN, { c: conv, a: deskRavi.id }, owner.token); // from an unlinked assignee: nothing removed
    await settle();
    assert.equal(received('asha', 'assignment:removed').length, 0);
    assert.deepEqual(
      received('ravi', 'assignment:removed').map((e) => [e.previous, e.assignee]),
      [['Ravi', null]],
    );
    assert.equal(received('owner', 'assignment:removed').length, 0);
  });

  test('"Assigned to me" lists only chats assigned to your linked assignee', async () => {
    await ok(ASSIGN, { c: conv, a: deskRavi.id }, owner.token);
    await ok(ASSIGN, { c: conv2, a: deskAsha.id }, owner.token);
    assert.deepEqual(await mine(ravi.token), [conv]);
    assert.deepEqual(await mine(asha.token), [conv2]);
    assert.deepEqual(await mine(owner.token), []); // owner isn't linked to any assignee
    assert.deepEqual(await mine(B.token), []);
    await ok(UPDATE, { id: deskRavi.id, i: { userId: null } }, owner.token);
    assert.deepEqual(await mine(ravi.token), []);
    await ok(UPDATE, { id: deskRavi.id, i: { userId: ravi.id } }, owner.token);
    assert.deepEqual(await mine(ravi.token), [conv]);
    const counts = (await ok(`{ assignees { name conversationCount } }`, undefined, owner.token)).assignees;
    assert.deepEqual(counts.map((a: any) => [a.name, a.conversationCount]), [['Asha', 1], ['Night shift', 0], ['Ravi', 1]]);
  });

  test('visibility and replies are unchanged: every agent sees every chat and can reply whoever it is assigned to', async () => {
    for (const a of [asha, owner]) assert.ok((await ok(CONVERSATIONS, {}, a.token)).conversations.nodes.some((c: any) => c.id === conv));
    // conv is assigned to Ravi; Asha replies anyway. Meta rejects the fake number, but the reply is accepted and saved.
    await prisma.whatsAppAccount.create({
      data: { workspaceId: ws.workspaceId, wabaId: 'w', phoneNumberId: `pn-assign-${run}`, accessToken: 'fake-token-e2e' },
    });
    try {
      const sent = (
        await ok(`mutation($i: SendTextInput!) { sendTextMessage(input: $i) { sentById senderName } }`, { i: { conversationId: conv, body: 'On it' } }, asha.token)
      ).sendTextMessage;
      assert.deepEqual(sent, { sentById: asha.id, senderName: 'Asha' });
    } finally {
      await prisma.whatsAppAccount.delete({ where: { workspaceId: ws.workspaceId } });
    }
  });

  test('concurrent reassignments: every history entry names the real previous assignee and ends at the final one', async () => {
    await ok(ASSIGN, { c: conv, a: nightShift.id }, owner.token);
    const before = (await timeline(conv)).length;
    const targets = [deskAsha, deskRavi, nightShift, deskAsha, deskRavi, deskAsha];
    const tokens = [owner.token, sam.token]; // supervisors and admins reassign; agents can't
    const results = await Promise.all(targets.map((t, i) => gql(ASSIGN, { c: conv, a: t.id }, tokens[i % tokens.length])));
    for (const r of results) assert.ok(!r.errors || r.errors[0].extensions?.code === 'ASSIGN_CONFLICT', JSON.stringify(r.errors));

    const final = (await ok(`query($id: ID!) { conversation(id: $id) { assignee { name } } }`, { id: conv }, owner.token)).conversation.assignee.name;
    const changes = (await timeline(conv)).slice(before).map((a: any) => {
      assert.equal(a.type, 'reassigned');
      const d = JSON.parse(a.data);
      return [d.previous, d.assignee] as [string, string];
    });
    // The recorded changes must chain from "Night shift" to the final assignee using every change exactly once
    const chains = (from: string, left: [string, string][]): boolean =>
      left.length === 0
        ? from === final
        : left.some(([p, n], i) => p === from && chains(n, left.filter((_, j) => j !== i)));
    assert.ok(chains('Night shift', changes), `history ${JSON.stringify(changes)} does not end at ${final}`);
  });

  test('deleting an assignee unassigns its chats and records it in each chat; deleting a user only unlinks', async () => {
    await ok(ASSIGN, { c: conv, a: nightShift.id }, owner.token);
    await ok(ASSIGN, { c: conv2, a: nightShift.id }, owner.token);
    await settle();
    resetEvents();
    await ok(`mutation($id: ID!) { deleteAssignee(id: $id) }`, { id: nightShift.id }, owner.token);
    await settle();
    for (const c of [conv, conv2]) {
      const last = (await timeline(c)).at(-1);
      assert.deepEqual([last.type, last.actorName, JSON.parse(last.data)], ['unassigned', 'assignflow', { assignee: 'Night shift', reason: 'assignee_deleted' }]);
    }
    assert.deepEqual(received('asha', 'assignee:deleted'), [{ id: nightShift.id }]);
    assert.equal(received('asha', 'conversation:assigned').length, 0);
    assert.equal(received('asha', 'activity:new').filter((a) => a.type === 'unassigned').length, 2);
    assert.equal(await errorCode(ASSIGN, { c: conv, a: nightShift.id }, owner.token), 'NOT_FOUND');

    const temp = await newAgent('Temp');
    const desk = (await ok(CREATE, { i: { name: 'Temp desk', color: '#0369a1', userId: temp.id } }, owner.token)).createAssignee;
    await prisma.user.delete({ where: { id: temp.id } });
    const after = await prisma.assignee.findUnique({ where: { id: desk.id } });
    assert.equal(after?.userId, null);
  });
});

describe('clear chat (for yourself only)', () => {
  const MSGS = `query($id: ID!) { messages(conversationId: $id, first: 100) { nodes { body } } }`;
  const PREVIEW = `{ conversations { nodes { id lastMessage { body } } } }`;
  const TIMELINE = `query($c: ID!) { conversationActivity(conversationId: $c) { type } }`;
  let ws: { token: string; workspaceId: string };
  let mate: string;
  let conv: string;

  before(async () => {
    ws = await newWorkspace('clear');
    const email = `e2e-clear-mate-${run}@example.com`;
    const user = await prisma.user.create({
      data: { name: 'Mate', email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role: 'agent', workspaceId: ws.workspaceId } } },
    });
    created.userIds.push(user.id);
    mate = (await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } })).login.token;
    await ok(SIMULATE, { i: { waId: '919191919191', name: 'Kavya', body: 'First question' } }, ws.token);
    conv = (await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes[0].id;
    await ok(`mutation($id: ID!) { closeConversation(id: $id) { id } }`, { id: conv }, mate);
    await ok(`mutation($id: ID!) { reopenConversation(id: $id) { id } }`, { id: conv }, mate);
  });

  test('clearing hides messages, history and the preview for you only; nothing is deleted', async () => {
    const before = await prisma.message.count({ where: { conversationId: conv } });
    await new Promise((r) => setTimeout(r, 20));
    const at = (await ok(`mutation($id: ID!) { clearConversation(id: $id) }`, { id: conv }, ws.token)).clearConversation;
    assert.ok(at);
    assert.deepEqual((await ok(MSGS, { id: conv }, ws.token)).messages.nodes, []);
    assert.deepEqual((await ok(TIMELINE, { c: conv }, ws.token)).conversationActivity, []);
    assert.equal((await ok(PREVIEW, undefined, ws.token)).conversations.nodes.find((c: any) => c.id === conv).lastMessage, null);
    // Teammate still sees everything
    assert.deepEqual((await ok(MSGS, { id: conv }, mate)).messages.nodes.map((m: any) => m.body), ['First question']);
    assert.equal((await ok(TIMELINE, { c: conv }, mate)).conversationActivity.length, 2);
    assert.equal((await ok(PREVIEW, undefined, mate)).conversations.nodes.find((c: any) => c.id === conv).lastMessage.body, 'First question');
    assert.equal(await prisma.message.count({ where: { conversationId: conv } }), before);
  });

  test('new messages after clearing show up again; clearing again works', async () => {
    await new Promise((r) => setTimeout(r, 20));
    await ok(SIMULATE, { i: { waId: '919191919191', body: 'Second question' } }, ws.token);
    assert.deepEqual((await ok(MSGS, { id: conv }, ws.token)).messages.nodes.map((m: any) => m.body), ['Second question']);
    assert.equal((await ok(PREVIEW, undefined, ws.token)).conversations.nodes.find((c: any) => c.id === conv).lastMessage.body, 'Second question');
    await new Promise((r) => setTimeout(r, 20));
    await ok(`mutation($id: ID!) { clearConversation(id: $id) }`, { id: conv }, ws.token);
    assert.deepEqual((await ok(MSGS, { id: conv }, ws.token)).messages.nodes, []);
  });

  test("other workspaces can't clear it", async () => {
    assert.equal(await errorCode(`mutation($id: ID!) { clearConversation(id: $id) }`, { id: conv }, B.token), 'NOT_FOUND');
    assert.equal(await errorCode(`mutation { clearConversation(id: "nope") }`, undefined, ws.token), 'NOT_FOUND');
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

describe('WhatsApp integration: config, webhook, numbers, templates', () => {
  let ws: { token: string; workspaceId: string };
  const phoneNumberId = `pn-hook-${run}`;
  const hook = (value: object) =>
    fetch(`${API}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId }, ...value } }] }] }),
    });
  const status = (id: string, s: string, extra: object = {}) => ({ id, status: s, timestamp: '1760000000', recipient_id: '919876543210', ...extra });
  // The webhook answers 200 straight away and processes afterwards
  async function eventually<T>(read: () => Promise<T>, done: (v: T) => boolean) {
    for (let i = 0; i < 40; i++) {
      const v = await read();
      if (done(v)) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    return read();
  }

  before(async () => {
    ws = await newWorkspace('wa');
    await prisma.whatsAppAccount.create({ data: { workspaceId: ws.workspaceId, wabaId: 'w', phoneNumberId, accessToken: 'fake-token-e2e' } });
  });

  test('isProd is true only when NODE_ENV=production', () => {
    const isProd = (nodeEnv?: string) => {
      const env = { ...process.env };
      if (nodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = nodeEnv;
      const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', 'import("./src/env.ts").then((m) => console.log(m.env.isProd))'], { env, encoding: 'utf8' });
      return r.stdout.trim();
    };
    assert.deepEqual([isProd('production'), isProd('development'), isProd(undefined)], ['true', 'false', 'false']);
  });

  test('webhook signatures: valid HMAC accepted; wrong, missing or unsigned rejected (unsigned allowed only outside production without a secret)', () => {
    const body = Buffer.from('{"entry":[]}');
    const sign = (secret: string) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    assert.equal(validSignature(body, sign('app-secret'), 'app-secret', true), true);
    assert.equal(validSignature(body, sign('other-secret'), 'app-secret', true), false);
    assert.equal(validSignature(body, undefined, 'app-secret', false), false);
    assert.equal(validSignature(body, 'sha256=short', 'app-secret', true), false);
    assert.equal(validSignature(Buffer.from('{"entry":[1]}'), sign('app-secret'), 'app-secret', true), false); // body changed
    assert.equal(validSignature(body, undefined, '', true), false); // production without META_APP_SECRET
    assert.equal(validSignature(body, undefined, '', false), true); // local development
  });

  test('delivery statuses from Meta move sent -> delivered -> read, never backwards; failures keep the reason', async () => {
    await ok(SIMULATE, { i: { waId: '919876500001', name: 'Hook', body: 'hi' } }, ws.token);
    const conversationId = (await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes[0].id;
    const out = (body: string, wamid: string) =>
      prisma.message.create({ data: { conversationId, direction: 'out', type: 'text', body, status: 'sent', waMessageId: wamid } });
    const m = await out('one', `wamid.e2e-1-${run}`);
    const read = () => prisma.message.findUniqueOrThrow({ where: { id: m.id } });

    assert.equal((await hook({ statuses: [status(m.waMessageId!, 'delivered')] })).status, 200);
    assert.equal((await eventually(read, (x) => x.status === 'delivered')).status, 'delivered');
    await hook({ statuses: [status(m.waMessageId!, 'read')] });
    assert.equal((await eventually(read, (x) => x.status === 'read')).status, 'read');
    await hook({ statuses: [status(m.waMessageId!, 'delivered')] }); // late, out of order
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await read()).status, 'read');

    const f = await out('two', `wamid.e2e-2-${run}`);
    await hook({ statuses: [status(f.waMessageId!, 'failed', { errors: [{ code: 131047, title: 'Re-engagement message' }] })] });
    const failed = await eventually(() => prisma.message.findUniqueOrThrow({ where: { id: f.id } }), (x) => x.status === 'failed');
    assert.deepEqual([failed.status, failed.error], ['failed', 'Re-engagement message']);
  });

  test('real incoming messages are saved once with their WhatsApp id and open the 24-hour window', async () => {
    const wamid = `wamid.e2e-in-${run}`;
    const message = { from: '919876500002', id: wamid, timestamp: '1760000000', type: 'text', text: { body: 'Do you fit tyres on Sunday?' } };
    const contacts = [{ profile: { name: 'Real Customer' }, wa_id: '919876500002' }];
    await hook({ contacts, messages: [message] });
    await hook({ contacts, messages: [message] }); // Meta retry
    const saved = await eventually(() => prisma.message.findMany({ where: { waMessageId: wamid } }), (x) => x.length > 0);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await prisma.message.count({ where: { waMessageId: wamid } })), 1);
    assert.deepEqual([saved[0].direction, saved[0].body], ['in', 'Do you fit tyres on Sunday?']);
    const c = await prisma.conversation.findUniqueOrThrow({ where: { id: saved[0].conversationId } });
    assert.ok(c.lastInboundAt && Date.now() - c.lastInboundAt.getTime() < 60_000);
  });

  test('numbers must be real international numbers: starting a chat without a country code is refused', async () => {
    const start = `mutation($i: StartConversationInput!) { startConversation(input: $i) { contact { waId } } }`;
    assert.equal(await errorCode(start, { i: { waId: '9016312927' } }, ws.token), 'BAD_USER_INPUT');
    assert.equal(await errorCode(start, { i: { waId: '915555555555' } }, ws.token), 'BAD_USER_INPUT');
    assert.equal((await ok(start, { i: { waId: '+971 50 123 4567' } }, ws.token)).startConversation.contact.waId, '971501234567');
    assert.equal((await rest('POST', '/inbox/contacts', ws.token, { waId: '9016312927' })).status, 400);
  });

  test('replying to an old chat whose number lacks the country code is refused before calling WhatsApp, and stores nothing', async () => {
    const contact = await prisma.contact.create({ data: { workspaceId: ws.workspaceId, waId: '9016312927' } });
    const conv = await prisma.conversation.create({ data: { workspaceId: ws.workspaceId, contactId: contact.id, lastInboundAt: new Date() } });
    const r = await gql(`mutation($i: SendTextInput!) { sendTextMessage(input: $i) { id } }`, { i: { conversationId: conv.id, body: 'hi' } }, ws.token);
    assert.equal(r.errors?.[0].extensions?.code, 'INVALID_PHONE');
    assert.match(r.errors![0].message, /country code/);
    assert.equal(await prisma.message.count({ where: { conversationId: conv.id } }), 0);
  });

  test('template language: the approved one is used; unapproved names, languages and templates with variables are refused', () => {
    const t = (name: string, language: string, needsParameters = false): ApprovedTemplate => ({ name, language, category: 'UTILITY', body: '', needsParameters });
    const approved = [t('hello_world', 'en_US'), t('offer', 'en'), t('offer', 'ar'), t('greet', 'en', true)];
    const code = (fn: () => unknown) => {
      try {
        fn();
        return 'ok';
      } catch (err) {
        return (err as any).code;
      }
    };
    assert.equal(pickTemplateLanguage(approved, 'hello_world'), 'en_US'); // the old default 'en' would fail at Meta
    assert.equal(pickTemplateLanguage(approved, 'hello_world', 'en_US'), 'en_US');
    assert.equal(code(() => pickTemplateLanguage(approved, 'hello_world', 'en')), 'TEMPLATE_LANGUAGE');
    assert.equal(pickTemplateLanguage(approved, 'offer', 'ar'), 'ar');
    assert.equal(code(() => pickTemplateLanguage(approved, 'offer')), 'TEMPLATE_LANGUAGE'); // ambiguous
    assert.equal(code(() => pickTemplateLanguage(approved, 'missing')), 'TEMPLATE_NOT_APPROVED');
    assert.equal(code(() => pickTemplateLanguage(approved, 'greet')), 'TEMPLATE_NEEDS_PARAMETERS');
  });

  test('messageTemplates needs a connected number and reports Meta errors instead of an empty list', async () => {
    const Q = `{ messageTemplates { name language category body needsParameters } }`;
    assert.equal(await errorCode(Q, undefined, B.token), 'WHATSAPP_NOT_CONNECTED');
    assert.equal(await errorCode(Q, undefined, ws.token), 'WHATSAPP_API_ERROR'); // fake token: Meta refuses it
    assert.equal((await gql(Q)).errors?.[0].extensions?.code, 'UNAUTHENTICATED');
  });
});

describe('roles, team management and authorization', () => {
  type U = { id: string; token: string; email: string };
  const ME = `{ me { user { id } workspace { id } role canManageLabels } }`;
  const MEMBERS = `{ members { userId name email role isOwner canManageLabels } }`;
  const INVITE = `mutation($i: InviteMemberInput!) { inviteMember(input: $i) { invited emailSent member { userId name email role isOwner } } }`;
  const SET_ROLE = `mutation($u: ID!, $r: String!) { updateMemberRole(userId: $u, role: $r) { userId role } }`;
  const REMOVE = `mutation($u: ID!) { removeMember(userId: $u) }`;
  const JOIN_LINK = `mutation { createJoinLink { token expiresAt } }`;
  const REGISTER = `mutation($i: RegisterInput!) { register(input: $i) { token workspace { id } } }`;
  const ASSIGN = `mutation($c: ID!, $a: ID) { assignConversation(conversationId: $c, assigneeId: $a) { assignee { name } } }`;
  const CREATE_LABEL = `mutation($i: CreateLabelInput!) { createLabel(input: $i) { id } }`;
  let ws: { token: string; workspaceId: string };
  let owner: U;
  let admin: U;
  let sup: U;
  let agent: U;
  let conv: string;

  async function member(name: string, role: string): Promise<U> {
    const email = `e2e-roles-${name.toLowerCase()}-${run}@example.com`;
    const user = await prisma.user.create({
      data: { name, email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role, workspaceId: ws.workspaceId } } },
    });
    created.userIds.push(user.id);
    const { login } = await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } });
    return { id: user.id, token: login.token, email };
  }
  const role = async (token: string) => (await ok(ME, undefined, token)).me.role;
  function connect(token: string) {
    const socket = connectSocket(API, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
    const events: { event: string; data: any }[] = [];
    socket.onAny((event, data) => events.push({ event, data }));
    const ready = new Promise<boolean>((resolve) => {
      socket.on('connect', () => resolve(true));
      socket.on('connect_error', () => resolve(false));
    });
    return { socket, events, ready };
  }
  const settle = () => new Promise((r) => setTimeout(r, 300));

  before(async () => {
    ws = await newWorkspace('roles');
    const me = (await ok(ME, undefined, ws.token)).me;
    owner = { id: me.user.id, token: ws.token, email: `e2e-roles-${run}@example.com` };
    admin = await member('Adam', 'admin');
    sup = await member('Sara', 'supervisor');
    agent = await member('Aman', 'agent');
    await ok(SIMULATE, { i: { waId: '917777700001', name: 'Rahul', body: 'Hi' } }, ws.token);
    conv = (await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes[0].id;
  });

  test('each member sees their own role; supervisors can manage labels without a grant, agents cannot', async () => {
    assert.deepEqual(
      [await role(owner.token), await role(admin.token), await role(sup.token), await role(agent.token)],
      ['owner', 'admin', 'supervisor', 'agent'],
    );
    assert.equal((await ok(ME, undefined, sup.token)).me.canManageLabels, true);
    assert.equal((await ok(ME, undefined, agent.token)).me.canManageLabels, false);
    assert.ok((await ok(CREATE_LABEL, { i: { name: 'VIP', color: '#6d28d9' } }, sup.token)).createLabel.id);
    assert.equal(await errorCode(CREATE_LABEL, { i: { name: 'Nope', color: '#000000' } }, agent.token), 'FORBIDDEN');
  });

  test('only admins (owner or admin) can see and manage the team', async () => {
    const { members } = await ok(MEMBERS, undefined, admin.token);
    assert.deepEqual(
      members.map((m: any) => [m.name, m.role, m.isOwner]),
      [['Adam', 'admin', false], ['Aman', 'agent', false], ['roles', 'owner', true], ['Sara', 'supervisor', false]],
    );
    assert.ok(members.every((m: any) => m.email.includes('@')));
    for (const t of [sup.token, agent.token]) {
      assert.equal(await errorCode(MEMBERS, undefined, t), 'FORBIDDEN');
      assert.equal(await errorCode(INVITE, { i: { name: 'X', email: `x-${run}@example.com`, role: 'agent' } }, t), 'FORBIDDEN');
      assert.equal(await errorCode(SET_ROLE, { u: agent.id, r: 'admin' }, t), 'FORBIDDEN');
      assert.equal(await errorCode(REMOVE, { u: agent.id }, t), 'FORBIDDEN');
      assert.equal(await errorCode(JOIN_LINK, undefined, t), 'FORBIDDEN');
      assert.equal(await errorCode(`mutation($u: ID!) { setLabelPermission(userId: $u, canManageLabels: true) { userId } }`, { u: agent.id }, t), 'FORBIDDEN');
    }
    assert.equal(await errorCode(SET_ROLE, { u: agent.id, r: 'supervisor' }, agent.token), 'FORBIDDEN'); // no self-promotion
  });

  test('invite: a new email gets one account with the chosen role and an emailed link; an existing account is added, never duplicated', async () => {
    const email = `e2e-roles-invited-${run}@example.com`;
    const r = (await ok(INVITE, { i: { name: 'Nina', email: email.toUpperCase(), role: 'supervisor' } }, admin.token)).inviteMember;
    created.userIds.push(r.member.userId);
    assert.deepEqual([r.invited, r.member.email, r.member.role], [true, email, 'supervisor']);
    assert.equal(await prisma.user.count({ where: { email } }), 1);
    // The invite is a single-use "choose your password" link (the same table as Forgot password)
    assert.equal(await prisma.passwordResetToken.count({ where: { userId: r.member.userId, usedAt: null } }), 1);
    assert.equal(await errorCode(INVITE, { i: { name: 'Nina again', email, role: 'agent' } }, admin.token), 'MEMBER_EXISTS');

    // Workspace B's owner already has an account: added here as an agent, name and password untouched
    const bUser = await prisma.user.findFirstOrThrow({ where: { members: { some: { workspaceId: B.workspaceId, role: 'owner' } } } });
    const added = (await ok(INVITE, { i: { name: 'Different name', email: bUser.email, role: 'agent' } }, owner.token)).inviteMember;
    assert.deepEqual([added.invited, added.member.userId, added.member.name, added.member.role], [false, bUser.id, bUser.name, 'agent']);
    assert.equal(await prisma.user.count({ where: { email: bUser.email } }), 1);
    assert.equal(await prisma.passwordResetToken.count({ where: { userId: bUser.id } }), 0); // no password link sent
    assert.equal(await role(B.token), 'owner'); // their own workspace is unaffected
    await prisma.member.delete({ where: { userId_workspaceId: { userId: bUser.id, workspaceId: ws.workspaceId } } });

    for (const r of ['owner', 'superadmin', ''])
      assert.equal(await errorCode(INVITE, { i: { name: 'X', email: `x2-${run}@example.com`, role: r } }, admin.token), 'BAD_USER_INPUT');
  });

  test('role changes: admins only, never the owner or themselves; applied at once and announced over Socket.IO', async () => {
    const live = connect(agent.token);
    assert.equal(await live.ready, true);
    await ok(SET_ROLE, { u: agent.id, r: 'supervisor' }, admin.token);
    await settle();
    assert.deepEqual(
      live.events.filter((e) => e.event === 'member:permissions' && e.data.userId === agent.id).map((e) => [e.data.role, e.data.canManageLabels]),
      [['supervisor', true]],
    );
    assert.ok((await ok(CREATE_LABEL, { i: { name: 'Promoted', color: '#1d4ed8' } }, agent.token)).createLabel.id); // same token, new rights
    await ok(SET_ROLE, { u: agent.id, r: 'agent' }, owner.token);
    assert.equal(await errorCode(CREATE_LABEL, { i: { name: 'Demoted', color: '#047857' } }, agent.token), 'FORBIDDEN');
    live.socket.disconnect();

    assert.equal(await errorCode(SET_ROLE, { u: owner.id, r: 'agent' }, admin.token), 'OWNER_PROTECTED');
    assert.equal(await errorCode(SET_ROLE, { u: admin.id, r: 'agent' }, admin.token), 'CANNOT_CHANGE_SELF');
    assert.equal(await errorCode(SET_ROLE, { u: agent.id, r: 'owner' }, admin.token), 'BAD_USER_INPUT');
    assert.equal(await errorCode(SET_ROLE, { u: (await ok(ME, undefined, B.token)).me.user.id, r: 'agent' }, admin.token), 'NOT_FOUND');
    // An admin can make another admin
    const temp = await member('Tara', 'agent');
    assert.equal((await ok(SET_ROLE, { u: temp.id, r: 'admin' }, admin.token)).updateMemberRole.role, 'admin');
    assert.ok((await ok(MEMBERS, undefined, temp.token)).members.length > 0);
    await ok(REMOVE, { u: temp.id }, admin.token);
  });

  test('removing a member cuts off GraphQL, REST and Socket.IO at once; the account itself stays', async () => {
    const gone = await member('Gita', 'agent');
    const desk = (await ok(`mutation($i: CreateAssigneeInput!) { createAssignee(input: $i) { id } }`, { i: { name: 'Gita desk', color: '#047857', userId: gone.id } }, admin.token)).createAssignee;
    const live = connect(gone.token);
    assert.equal(await live.ready, true);
    const closed = new Promise<boolean>((resolve) => live.socket.on('disconnect', () => resolve(true)));

    assert.equal(await errorCode(REMOVE, { u: owner.id }, admin.token), 'OWNER_PROTECTED');
    assert.equal(await errorCode(REMOVE, { u: admin.id }, admin.token), 'CANNOT_CHANGE_SELF');
    assert.equal((await ok(REMOVE, { u: gone.id }, admin.token)).removeMember, gone.id);

    assert.equal(await closed, true);
    assert.equal((await gql(CONVERSATIONS, {}, gone.token)).errors?.[0].extensions?.code, 'UNAUTHENTICATED');
    assert.equal((await rest('GET', '/inbox/conversations', gone.token)).status, 401);
    const again = connect(gone.token);
    assert.equal(await again.ready, false); // can't reconnect with the old token
    again.socket.disconnect();
    assert.ok(await prisma.user.findUnique({ where: { id: gone.id } }));
    assert.equal((await prisma.assignee.findUniqueOrThrow({ where: { id: desk.id } })).userId, null); // unlinked
    assert.equal(await errorCode(REMOVE, { u: gone.id }, admin.token), 'NOT_FOUND');
  });

  test('self-registration through a signup link always gives Agent; a role cannot be chosen; bad links are refused', async () => {
    const { token } = (await ok(JOIN_LINK, undefined, admin.token)).createJoinLink;
    assert.equal((await ok(`query($t: String!) { joinLinkInfo(token: $t) { workspaceName } }`, { t: token })).joinLinkInfo.workspaceName, 'roles');

    const email = `e2e-roles-self-${run}@example.com`;
    const reg = (await ok(REGISTER, { i: { name: 'Selfie', email, password: 'password123', joinToken: token } })).register;
    created.userIds.push((await prisma.user.findUniqueOrThrow({ where: { email } })).id);
    assert.equal(reg.workspace.id, ws.workspaceId);
    assert.equal(await role(reg.token), 'agent');
    // There is no role field to send
    const withRole = await gql(REGISTER, { i: { name: 'Sneaky', email: `e2e-roles-sneaky-${run}@example.com`, password: 'password123', joinToken: token, role: 'admin' } });
    assert.ok(withRole.errors?.length && !withRole.data);
    assert.equal(await prisma.user.count({ where: { email: `e2e-roles-sneaky-${run}@example.com` } }), 0);

    const bad = (t: string) => gql(REGISTER, { i: { name: 'Bad', email: `e2e-roles-bad-${run}@example.com`, password: 'password123', joinToken: t } });
    assert.equal((await bad(token.slice(0, -2) + 'xx')).errors?.[0].extensions?.code, 'INVALID_JOIN_LINK'); // tampered
    assert.equal((await bad(agent.token)).errors?.[0].extensions?.code, 'INVALID_JOIN_LINK'); // a sign-in token isn't a signup link
    assert.equal((await gql(ME, undefined, token)).errors?.[0].extensions?.code, 'UNAUTHENTICATED'); // and a signup link isn't a sign-in
    // Without a link: the original sign-up (own workspace, as its owner) still works, but needs a workspace name
    assert.equal((await gql(REGISTER, { i: { name: 'No ws', email: `e2e-roles-nows-${run}@example.com`, password: 'password123' } })).errors?.[0].extensions?.code, 'BAD_USER_INPUT');
    const own = await newWorkspace('roles-own');
    assert.equal(await role(own.token), 'owner');
  });

  test('an existing account joins through the link as Agent without a duplicate account; members keep their role', async () => {
    const { token } = (await ok(JOIN_LINK, undefined, owner.token)).createJoinLink;
    const bUser = await prisma.user.findFirstOrThrow({ where: { members: { some: { workspaceId: B.workspaceId, role: 'owner' } } } });
    const joined = (await ok(`mutation($t: String!) { joinWorkspace(token: $t) { token workspace { id } } }`, { t: token }, B.token)).joinWorkspace;
    assert.equal(joined.workspace.id, ws.workspaceId);
    assert.equal(await role(joined.token), 'agent');
    assert.equal(await prisma.user.count({ where: { email: bUser.email } }), 1);
    assert.equal(await role(B.token), 'owner');
    await prisma.member.delete({ where: { userId_workspaceId: { userId: bUser.id, workspaceId: ws.workspaceId } } });
    // Already a member: role unchanged (a supervisor isn't demoted by opening the link)
    const again = (await ok(`mutation($t: String!) { joinWorkspace(token: $t) { token } }`, { t: token }, sup.token)).joinWorkspace;
    assert.equal(await role(again.token), 'supervisor');
  });

  test('assignments by role: agents only take unassigned chats or release their own; supervisors and admins do anything', async () => {
    const mk = async (name: string, userId?: string) =>
      (await ok(`mutation($i: CreateAssigneeInput!) { createAssignee(input: $i) { id } }`, { i: { name, color: '#047857', userId } }, admin.token)).createAssignee.id;
    const amanDesk = await mk('Aman desk', agent.id);
    const saraDesk = await mk('Sara desk', sup.id);
    const pool = await mk('Pool');

    assert.equal(await errorCode(ASSIGN, { c: conv, a: pool }, agent.token), 'FORBIDDEN'); // to someone else
    assert.equal((await ok(ASSIGN, { c: conv, a: amanDesk }, agent.token)).assignConversation.assignee.name, 'Aman desk'); // take
    assert.equal(await errorCode(ASSIGN, { c: conv, a: pool }, agent.token), 'FORBIDDEN'); // reassign own to someone else
    assert.equal((await ok(ASSIGN, { c: conv, a: null }, agent.token)).assignConversation.assignee, null); // release
    await ok(ASSIGN, { c: conv, a: saraDesk }, sup.token);
    assert.equal(await errorCode(ASSIGN, { c: conv, a: amanDesk }, agent.token), 'FORBIDDEN'); // take someone else's chat
    assert.equal(await errorCode(ASSIGN, { c: conv, a: null }, agent.token), 'FORBIDDEN'); // unassign someone else
    assert.equal((await ok(ASSIGN, { c: conv, a: amanDesk }, sup.token)).assignConversation.assignee.name, 'Aman desk'); // supervisor reassigns
    assert.equal((await ok(ASSIGN, { c: conv, a: pool }, admin.token)).assignConversation.assignee.name, 'Pool');
    // A label grant doesn't grant reassigning
    await ok(`mutation($u: ID!) { setLabelPermission(userId: $u, canManageLabels: true) { userId } }`, { u: agent.id }, admin.token);
    assert.equal(await errorCode(ASSIGN, { c: conv, a: amanDesk }, agent.token), 'FORBIDDEN');
    // Every member still sees the chat and could reply to it
    assert.ok((await ok(CONVERSATIONS, {}, agent.token)).conversations.nodes.some((c: any) => c.id === conv));
  });

  test('system settings and message moderation stay admin-only (GraphQL and REST)', async () => {
    const connect = `mutation { connectWhatsApp(input: { wabaId: "1", phoneNumberId: "1", accessToken: "short" }) { wabaId } }`;
    for (const t of [sup.token, agent.token]) {
      assert.equal(await errorCode(connect, undefined, t), 'FORBIDDEN');
      assert.equal((await rest('POST', '/settings/whatsapp', t, { wabaId: '1', phoneNumberId: '1', accessToken: 'short' })).status, 403);
    }
    assert.equal(await errorCode(connect, undefined, admin.token), 'BAD_USER_INPUT'); // past the permission check
    const m = await prisma.message.create({ data: { conversationId: conv, direction: 'out', type: 'text', body: 'agent wrote', status: 'sent', sentById: agent.id } });
    const edit = `mutation($i: EditMessageInput!) { editMessage(input: $i) { body } }`;
    assert.equal(await errorCode(edit, { i: { messageId: m.id, body: 'supervisor edit', version: 0 } }, sup.token), 'FORBIDDEN');
    assert.equal((await ok(edit, { i: { messageId: m.id, body: 'admin edit', version: 0 } }, admin.token)).editMessage.body, 'admin edit');
  });
});

describe('assign to people (supervisors and agents) from the Assign dropdown', () => {
  type U = { id: string; token: string };
  const TO_MEMBER = `mutation($c: ID!, $m: ID) { assignConversation(conversationId: $c, memberId: $m) { id assignee { id name color userId } } }`;
  const TO_ASSIGNEE = `mutation($c: ID!, $a: ID) { assignConversation(conversationId: $c, assigneeId: $a) { id assignee { id name userId } } }`;
  let ws: { token: string; workspaceId: string };
  let owner: U;
  let sup: U;
  let agent: U;
  let other: U;
  let c1: string;
  let c2: string;
  let c3: string;

  async function member(name: string, role: string): Promise<U> {
    const email = `e2e-people-${name.toLowerCase()}-${run}@example.com`;
    const user = await prisma.user.create({
      data: { name, email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role, workspaceId: ws.workspaceId } } },
    });
    created.userIds.push(user.id);
    const { login } = await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } });
    return { id: user.id, token: login.token };
  }
  const linkedCount = (userId: string) => prisma.assignee.count({ where: { workspaceId: ws.workspaceId, userId } });

  before(async () => {
    ws = await newWorkspace('people');
    owner = { id: (await ok(`{ me { user { id } } }`, undefined, ws.token)).me.user.id, token: ws.token };
    sup = await member('Sana', 'supervisor');
    agent = await member('Arun', 'agent');
    other = await member('Omar', 'agent');
    for (const [waId, name] of [['917000000001', 'C One'], ['917000000002', 'C Two'], ['917000000003', 'C Three']])
      await ok(SIMULATE, { i: { waId, name, body: 'hi' } }, ws.token);
    const nodes = (await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes;
    [c1, c2, c3] = ['C One', 'C Two', 'C Three'].map((n) => nodes.find((c: any) => c.contact.name === n).id);
  });

  test('the dropdown lists live members with their roles; removed members disappear', async () => {
    const names = async () => (await ok(`{ workspaceMembers { id name role } }`, undefined, agent.token)).workspaceMembers.map((m: any) => [m.name, m.role]);
    assert.deepEqual(await names(), [['Arun', 'agent'], ['Omar', 'agent'], ['people', 'owner'], ['Sana', 'supervisor']]);
    const temp = await member('Tina', 'agent');
    assert.ok((await names()).some(([n]: string[]) => n === 'Tina'));
    await ok(`mutation($u: ID!) { removeMember(userId: $u) }`, { u: temp.id }, owner.token);
    assert.ok(!(await names()).some(([n]: string[]) => n === 'Tina'));
    assert.equal(await errorCode(TO_MEMBER, { c: c1, m: temp.id }, owner.token), 'NOT_FOUND'); // removed: can't be assigned
  });

  test('supervisors and admins assign to either role; the person gets one linked assignee in their role colour', async () => {
    const r = (await ok(TO_MEMBER, { c: c1, m: agent.id }, sup.token)).assignConversation.assignee;
    assert.deepEqual([r.name, r.color, r.userId], ['Arun', '#047857', agent.id]);
    const again = (await ok(TO_MEMBER, { c: c2, m: agent.id }, owner.token)).assignConversation.assignee;
    assert.equal(again.id, r.id); // reused, not duplicated
    assert.equal(await linkedCount(agent.id), 1);
    const toSup = (await ok(TO_MEMBER, { c: c1, m: sup.id }, owner.token)).assignConversation.assignee; // reassign to a supervisor
    assert.deepEqual([toSup.name, toSup.color, toSup.userId], ['Sana', '#1d4ed8', sup.id]);
    assert.equal((await ok(TO_MEMBER, { c: c1, m: agent.id }, sup.token)).assignConversation.assignee.userId, agent.id); // and back

    // Counts, filters and "Assigned to me" work exactly as for any assignee
    const counts = (await ok(`{ assignees { name userId conversationCount } }`, undefined, owner.token)).assignees;
    assert.deepEqual(counts.map((a: any) => [a.name, a.conversationCount]), [['Arun', 2], ['Sana', 0]]);
    assert.deepEqual((await ok(`{ conversations(assignee: "me") { nodes { id } } }`, undefined, agent.token)).conversations.nodes.map((c: any) => c.id).sort(), [c1, c2].sort());
    assert.deepEqual((await ok(`query($a: ID) { conversations(assignee: $a) { nodes { id } } }`, { a: r.id }, owner.token)).conversations.nodes.length, 2);
  });

  test('agents only take an unassigned chat for themselves or release their own; refused requests create nothing', async () => {
    assert.equal(await errorCode(TO_MEMBER, { c: c3, m: other.id }, agent.token), 'FORBIDDEN'); // someone else
    assert.equal(await linkedCount(other.id), 0);
    assert.equal(await errorCode(TO_MEMBER, { c: c1, m: other.id }, agent.token), 'FORBIDDEN');
    // Omar can't take Arun's chat (refused before his assignee is created)
    assert.equal(await errorCode(TO_MEMBER, { c: c1, m: other.id }, other.token), 'FORBIDDEN');
    assert.equal(await linkedCount(other.id), 0);
    // Omar takes the unassigned chat: his assignee is created on first use
    assert.equal((await ok(TO_MEMBER, { c: c3, m: other.id }, other.token)).assignConversation.assignee.userId, other.id);
    assert.equal(await linkedCount(other.id), 1);
    assert.equal((await ok(TO_MEMBER, { c: c3, m: other.id }, other.token)).assignConversation.assignee.userId, other.id); // no-op
    assert.equal(await errorCode(TO_ASSIGNEE, { c: c3, a: null }, agent.token), 'FORBIDDEN'); // Arun can't release Omar's
    assert.equal((await ok(TO_ASSIGNEE, { c: c3, a: null }, other.token)).assignConversation.assignee, null); // Omar releases his own
  });

  test('any member of this workspace can be assigned, admins included; outsiders and bad input are refused', async () => {
    // Admins/owners too, so their chats show in their My Chats (purple, the admin colour)
    const toOwner = (await ok(TO_MEMBER, { c: c3, m: owner.id }, sup.token)).assignConversation.assignee;
    assert.deepEqual([toOwner.color, toOwner.userId], ['#6d28d9', owner.id]);
    await ok(TO_ASSIGNEE, { c: c3, a: null }, owner.token);
    const bUser = (await ok(`{ me { user { id } } }`, undefined, B.token)).me.user.id;
    assert.equal(await errorCode(TO_MEMBER, { c: c3, m: bUser }, owner.token), 'NOT_FOUND'); // another workspace
    assert.equal(await errorCode(TO_MEMBER, { c: c3, m: agent.id }, B.token), 'NOT_FOUND'); // their chat isn't visible to B
    const desk = (await ok(`mutation { createAssignee(input: { name: "Desk", color: "#123456" }) { id } }`, undefined, owner.token)).createAssignee;
    const both = await gql(`mutation($c: ID!, $a: ID, $m: ID) { assignConversation(conversationId: $c, assigneeId: $a, memberId: $m) { id } }`, { c: c3, a: desk.id, m: agent.id }, owner.token);
    assert.equal(both.errors?.[0].extensions?.code, 'BAD_USER_INPUT');
    // Assigning by assignee id (existing desks) still works as before
    assert.equal((await ok(TO_ASSIGNEE, { c: c3, a: desk.id }, sup.token)).assignConversation.assignee.name, 'Desk');
  });

  test("a name already used by another assignee gets a number; notifications and events are the same as before", async () => {
    await ok(`mutation { createAssignee(input: { name: "Nadia", color: "#123456" }) { id } }`, undefined, owner.token); // unlinked, same name
    const nadia = await member('Nadia', 'agent');
    const live = connectSocket(API, { auth: { token: nadia.token }, transports: ['websocket'], forceNew: true });
    const events: { event: string; data: any }[] = [];
    live.onAny((event, data) => events.push({ event, data }));
    await new Promise<void>((resolve) => live.on('connect', () => resolve()));

    const r = (await ok(TO_MEMBER, { c: c3, m: nadia.id }, sup.token)).assignConversation.assignee;
    await new Promise((res) => setTimeout(res, 300));
    live.disconnect();
    assert.deepEqual([r.name, r.userId], ['Nadia (2)', nadia.id]);
    assert.ok(events.some((e) => e.event === 'assignee:saved' && e.data.id === r.id && e.data.conversationCount === 0));
    assert.deepEqual(events.filter((e) => e.event === 'conversation:assigned').map((e) => e.data.assignee.id), [r.id]);
    assert.deepEqual(events.filter((e) => e.event === 'assignment:you').map((e) => [e.data.conversationId, e.data.actorName]), [[c3, 'Sana']]);
    assert.ok(events.some((e) => e.event === 'activity:new' && e.data.type === 'reassigned' && JSON.parse(e.data.data).previous === 'Desk'));
  });
});

describe('"Add person" from the Assign dropdown', () => {
  const INVITE = `mutation($i: InviteMemberInput!) { inviteMember(input: $i) { invited emailSent member { userId name email role } } }`;
  const MEMBERS = `{ workspaceMembers { id name role } }`;
  const TO_MEMBER = `mutation($c: ID!, $m: ID) { assignConversation(conversationId: $c, memberId: $m) { assignee { name color userId } } }`;
  let ws: { token: string; workspaceId: string };
  let sup: { id: string; token: string };
  let conv: string;

  before(async () => {
    ws = await newWorkspace('addperson');
    const email = `e2e-addperson-sup-${run}@example.com`;
    const user = await prisma.user.create({
      data: { name: 'Suri', email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role: 'supervisor', workspaceId: ws.workspaceId } } },
    });
    created.userIds.push(user.id);
    sup = { id: user.id, token: (await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } })).login.token };
    await ok(SIMULATE, { i: { waId: '917100000001', name: 'Kiran', body: 'hi' } }, ws.token);
    conv = (await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes[0].id;
  });

  test('an admin adds a new person: one account, password-setup invite, listed at once with the role, assignable straight away', async () => {
    const email = `e2e-addperson-new-${run}@example.com`;
    const r = (await ok(INVITE, { i: { name: 'Devi', email, role: 'agent' } }, ws.token)).inviteMember;
    created.userIds.push(r.member.userId);
    assert.deepEqual([r.invited, r.member.role], [true, 'agent']);
    assert.equal(await prisma.user.count({ where: { email } }), 1);
    const invite = await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: r.member.userId, usedAt: null } });
    assert.ok(invite.expiresAt.getTime() - Date.now() > 6 * 24 * 3600 * 1000); // the 7-day invite link
    // Not signed in with a password nobody knows
    assert.equal((await gql(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } })).errors?.[0].extensions?.code, 'INVALID_CREDENTIALS');

    const listed = (await ok(MEMBERS, undefined, sup.token)).workspaceMembers.find((m: any) => m.id === r.member.userId);
    assert.deepEqual(listed, { id: r.member.userId, name: 'Devi', role: 'agent' });
    const a = (await ok(TO_MEMBER, { c: conv, m: r.member.userId }, sup.token)).assignConversation.assignee;
    assert.deepEqual([a.name, a.color, a.userId], ['Devi', '#047857', r.member.userId]);
  });

  test('an existing account is added to the workspace (no duplicate) with the chosen role', async () => {
    const bUser = await prisma.user.findFirstOrThrow({ where: { members: { some: { workspaceId: B.workspaceId, role: 'owner' } } } });
    const r = (await ok(INVITE, { i: { name: 'ignored', email: bUser.email, role: 'supervisor' } }, ws.token)).inviteMember;
    assert.deepEqual([r.invited, r.member.userId, r.member.name, r.member.role], [false, bUser.id, bUser.name, 'supervisor']);
    assert.equal(await prisma.user.count({ where: { email: bUser.email } }), 1);
    assert.ok((await ok(MEMBERS, undefined, ws.token)).workspaceMembers.some((m: any) => m.id === bUser.id && m.role === 'supervisor'));
    assert.equal(await errorCode(INVITE, { i: { name: 'x', email: bUser.email, role: 'agent' } }, ws.token), 'MEMBER_EXISTS');
    await prisma.member.delete({ where: { userId_workspaceId: { userId: bUser.id, workspaceId: ws.workspaceId } } });
  });

  test('only admins can add people; nothing is created when refused', async () => {
    const email = `e2e-addperson-refused-${run}@example.com`;
    assert.equal(await errorCode(INVITE, { i: { name: 'Nope', email, role: 'agent' } }, sup.token), 'FORBIDDEN');
    assert.equal((await gql(INVITE, { i: { name: 'Nope', email, role: 'agent' } })).errors?.[0].extensions?.code, 'UNAUTHENTICATED');
    assert.equal(await prisma.user.count({ where: { email } }), 0);
  });
});

describe('My Chats (conversations assigned to the signed-in user)', () => {
  const MINE = `query($l: ID) { conversations(assignee: "me", labelId: $l) { nodes { id unread lastMessageAt lastMessage { body } contact { name } assignee { userId } } } }`;
  const TO_MEMBER = `mutation($c: ID!, $m: ID) { assignConversation(conversationId: $c, memberId: $m) { id } }`;
  const UNASSIGN = `mutation($c: ID!) { assignConversation(conversationId: $c, assigneeId: null) { id } }`;
  let ws: { token: string; workspaceId: string };
  let sup: { id: string; token: string };
  let ana: { id: string; token: string };
  let ben: { id: string; token: string };
  const ids: Record<string, string> = {};
  const mine = async (token: string, labelId?: string) => (await ok(MINE, { l: labelId ?? null }, token)).conversations.nodes;
  const mineIds = async (token: string, labelId?: string) => (await mine(token, labelId)).map((c: any) => c.id);

  async function member(name: string, role: string) {
    const email = `e2e-mychats-${name.toLowerCase()}-${run}@example.com`;
    const user = await prisma.user.create({
      data: { name, email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role, workspaceId: ws.workspaceId } } },
    });
    created.userIds.push(user.id);
    return { id: user.id, token: (await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } })).login.token };
  }

  before(async () => {
    ws = await newWorkspace('mychats');
    sup = await member('Sid', 'supervisor');
    ana = await member('Ana', 'agent');
    ben = await member('Ben', 'agent');
    for (const [waId, name] of [['917200000001', 'P1'], ['917200000002', 'P2'], ['917200000003', 'P3'], ['917200000004', 'P4']]) {
      await ok(SIMULATE, { i: { waId, name, body: `hello from ${name}` } }, ws.token);
      await new Promise((r) => setTimeout(r, 15)); // distinct lastMessageAt for the sort check
    }
    for (const c of (await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes) ids[c.contact.name] = c.id;
  });

  test('only chats assigned to you, newest first, with unread counts and previews; nothing before you are linked', async () => {
    assert.deepEqual(await mineIds(ana.token), []); // not linked to any assignee yet
    await ok(TO_MEMBER, { c: ids.P1, m: ana.id }, sup.token);
    await ok(TO_MEMBER, { c: ids.P3, m: ana.id }, sup.token);
    await ok(TO_MEMBER, { c: ids.P2, m: ben.id }, sup.token);
    const list = await mine(ana.token);
    assert.deepEqual(list.map((c: any) => c.contact.name), ['P3', 'P1']); // newest first; Ben's P2 and unassigned P4 left out
    assert.ok(list.every((c: any) => c.assignee.userId === ana.id && c.unread === 1 && c.lastMessage.body.startsWith('hello from')));
    assert.deepEqual(await mineIds(ben.token), [ids.P2]);
    assert.deepEqual(await mineIds(sup.token), []); // the supervisor assigned them but owns none
    // The Inbox (no assignee filter) is unchanged: every member still sees every chat
    assert.equal((await ok(CONVERSATIONS, {}, ben.token)).conversations.nodes.length, 4);
  });

  test('label and unread information combine with My Chats', async () => {
    const label = (await ok(`mutation { createLabel(input: { name: "Urgent", color: "#d63384" }) { id } }`, undefined, sup.token)).createLabel;
    const add = `mutation($c: ID!, $l: ID!) { addConversationLabel(conversationId: $c, labelId: $l) { id } }`;
    await ok(add, { c: ids.P1, l: label.id }, sup.token);
    await ok(add, { c: ids.P2, l: label.id }, sup.token); // Ben's
    assert.deepEqual(await mineIds(ana.token, label.id), [ids.P1]);
    await ok(`mutation($id: ID!) { markConversationRead(id: $id) { id } }`, { id: ids.P3 }, ana.token);
    assert.deepEqual((await mine(ana.token)).map((c: any) => [c.contact.name, c.unread]), [['P3', 0], ['P1', 1]]);
  });

  test('assigning, reassigning and unassigning move chats in and out of My Chats, with live socket updates', async () => {
    const live = connectSocket(API, { auth: { token: ana.token }, transports: ['websocket'], forceNew: true });
    const events: { event: string; data: any }[] = [];
    live.onAny((event, data) => events.push({ event, data }));
    await new Promise<void>((resolve) => live.on('connect', () => resolve()));

    await ok(TO_MEMBER, { c: ids.P4, m: ana.id }, sup.token); // assigned to Ana
    assert.ok((await mineIds(ana.token)).includes(ids.P4));
    await ok(TO_MEMBER, { c: ids.P1, m: ben.id }, sup.token); // reassigned away from Ana
    assert.ok(!(await mineIds(ana.token)).includes(ids.P1));
    assert.ok((await mineIds(ben.token)).includes(ids.P1));
    await ok(UNASSIGN, { c: ids.P3 }, ana.token); // Ana releases her own
    assert.deepEqual(await mineIds(ana.token), [ids.P4]);
    await new Promise((r) => setTimeout(r, 300));
    live.disconnect();

    const assigned = events.filter((e) => e.event === 'conversation:assigned').map((e) => [e.data.conversationId, e.data.assignee?.userId ?? null]);
    assert.deepEqual(assigned, [[ids.P4, ana.id], [ids.P1, ben.id], [ids.P3, null]]);
    assert.deepEqual(events.filter((e) => e.event === 'assignment:you').map((e) => e.data.conversationId), [ids.P4]);
    assert.deepEqual(events.filter((e) => e.event === 'assignment:removed').map((e) => e.data.conversationId), [ids.P1]); // not P3: she did it herself
  });

  test("another workspace's chats never appear, and signed-out requests are refused", async () => {
    assert.deepEqual(await mineIds(B.token), []);
    assert.equal((await gql(MINE, { l: null })).errors?.[0].extensions?.code, 'UNAUTHENTICATED');
  });
});

describe('My Chats regressions: admins, name-only assignees, same-named users', () => {
  const MINE = `{ conversations(assignee: "me") { nodes { id } } }`;
  const TO_MEMBER = `mutation($c: ID!, $m: ID) { assignConversation(conversationId: $c, memberId: $m) { assignee { id name userId } } }`;
  const TO_ASSIGNEE = `mutation($c: ID!, $a: ID) { assignConversation(conversationId: $c, assigneeId: $a) { assignee { id } } }`;
  let ws: { token: string; workspaceId: string };
  let ownerId: string;
  let twin: { id: string; token: string }; // a different account with the owner's name
  const ids: Record<string, string> = {};
  const mine = async (token: string) => (await ok(MINE, undefined, token)).conversations.nodes.map((c: any) => c.id).sort();

  before(async () => {
    ws = await newWorkspace('Rhea'); // the owner's name is the label: "Rhea"
    ownerId = (await ok(`{ me { user { id } } }`, undefined, ws.token)).me.user.id;
    const email = `e2e-twin-${run}@example.com`;
    const user = await prisma.user.create({
      data: { name: 'rhea', email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role: 'supervisor', workspaceId: ws.workspaceId } } },
    });
    created.userIds.push(user.id);
    twin = { id: user.id, token: (await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } })).login.token };
    for (const [waId, name] of [['917500000001', 'R1'], ['917500000002', 'R2'], ['917500000003', 'R3']])
      await ok(SIMULATE, { i: { waId, name, body: 'hi' } }, ws.token);
    for (const c of (await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes) ids[c.contact.name] = c.id;
  });

  test('an admin (the owner) can assign a chat to themselves and it shows in their My Chats', async () => {
    assert.deepEqual(await mine(ws.token), []);
    const a = (await ok(TO_MEMBER, { c: ids.R1, m: ownerId }, ws.token)).assignConversation.assignee;
    assert.equal(a.userId, ownerId);
    assert.deepEqual(await mine(ws.token), [ids.R1]);
    assert.deepEqual(await mine(twin.token), []); // same name, different account: not theirs
  });

  test('a name-only assignee never counts as you, even with your exact name; linking it does', async () => {
    const legacy = (await ok(`mutation { createAssignee(input: { name: "Rhea Desk", color: "#0f2919" }) { id } }`, undefined, ws.token)).createAssignee;
    const named = (await ok(`mutation { createAssignee(input: { name: "rhea legacy", color: "#0f2919" }) { id } }`, undefined, ws.token)).createAssignee;
    await ok(TO_ASSIGNEE, { c: ids.R2, a: legacy.id }, ws.token);
    await ok(TO_ASSIGNEE, { c: ids.R3, a: named.id }, ws.token);
    assert.deepEqual(await mine(ws.token), [ids.R1]); // R2/R3 are on unlinked assignees
    assert.deepEqual(await mine(twin.token), []);
    // Linking the name-only assignee to the twin makes its chats theirs, not the owner's
    await ok(`mutation($id: ID!, $u: ID) { updateAssignee(id: $id, input: { userId: $u }) { id } }`, { id: named.id, u: twin.id }, ws.token);
    assert.deepEqual(await mine(twin.token), [ids.R3]);
    assert.deepEqual(await mine(ws.token), [ids.R1]);
    // And assigning the twin as a person reuses that linked assignee (no "(2)" duplicate)
    const again = (await ok(TO_MEMBER, { c: ids.R2, m: twin.id }, ws.token)).assignConversation.assignee;
    assert.equal(again.id, named.id);
    assert.deepEqual(await mine(twin.token), [ids.R2, ids.R3].sort());
  });

  test('reassigning away and unassigning take chats out of My Chats straight away', async () => {
    await ok(TO_MEMBER, { c: ids.R1, m: twin.id }, ws.token);
    assert.deepEqual(await mine(ws.token), []);
    assert.ok((await mine(twin.token)).includes(ids.R1));
    await ok(TO_ASSIGNEE, { c: ids.R1, a: null }, twin.token);
    assert.ok(!(await mine(twin.token)).includes(ids.R1));
  });
});

describe('quick replies ("/" in the message box)', () => {
  const Q = `query($s: String, $f: Int) { quickReplies(search: $s, first: $f) { id shortcut description category } }`;
  let ws: { token: string; workspaceId: string };
  let agentToken: string;
  const shortcuts = async (search?: string | null, token = ws.token, first?: number) =>
    (await ok(Q, { s: search ?? null, f: first ?? null }, token)).quickReplies.map((r: any) => r.shortcut);

  test('the dump parser reads rows as data: quotes, escapes, line breaks, NULLs, UTC dates; nothing executed', () => {
    const sql = `DROP TABLE IF EXISTS \`klever_tyres_chat\`;
CREATE TABLE \`klever_tyres_chat\` (\`id\` int);
INSERT INTO \`klever_tyres_chat\` (\`id\`, \`shortcut\`, \`description\`, \`category\`, \`created_by\`, \`updated_by\`, \`status\`, \`sort_order\`, \`created_at\`, \`updated_at\`) VALUES
(1, 'nostock', 'It\\'s out (for now), sorry; ask again', 'car_tyres', NULL, 6, 1, 2, '2026-07-16 15:38:14', NULL),
(2, 'Hours', 'Open\\nFri: 09:00 - 18:00\\n''Closed'' Sunday', NULL, NULL, NULL, 0, 1, NULL, NULL),
(3, '  ', 'blank shortcut skipped', 'other', NULL, NULL, 1, 3, NULL, NULL);`;
    const rows = parseQuickReplyDump(sql);
    assert.equal(rows.length, 2);
    assert.deepEqual([rows[0].shortcut, rows[0].description, rows[0].category, rows[0].updatedBy, rows[0].status], ['nostock', "It's out (for now), sorry; ask again", 'car_tyres', 6n, 1]);
    assert.equal(rows[0].createdAt?.toISOString(), '2026-07-16T15:38:14.000Z');
    assert.deepEqual([rows[1].description, rows[1].category, rows[1].status, rows[1].createdAt], ["Open\nFri: 09:00 - 18:00\n'Closed' Sunday", null, 0, null]);
  });

  before(async () => {
    ws = await newWorkspace('quick');
    const email = `e2e-quick-agent-${run}@example.com`;
    const user = await prisma.user.create({
      data: { name: 'Q Agent', email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role: 'agent', workspaceId: ws.workspaceId } } },
    });
    created.userIds.push(user.id);
    agentToken = (await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } })).login.token;
    const r = (shortcut: string, description: string, category: string, sortOrder: number, status = 1) => ({ workspaceId: ws.workspaceId, shortcut, description, category, sortOrder, status });
    await prisma.quickReply.createMany({
      data: [
        r('greetings', 'Hi there! Welcome to TyresCart.ae.', 'car_tyres', 30),
        r('tyrescart', 'TyresCart.ae are an independent online business.', 'car_tyres', 48),
        r('Stockcheck', 'Kindly allow me a moment to confirm the stock.', 'car_tyres', 6),
        r('Wheelalignment', 'Alignment check is free; fixing starts from AED 150+', 'car_services', 12),
        r('Insurance Quote', 'Comprehensive or third party: 100% covered_', 'car_insurance', 66),
        r('tyrescart-old', 'Disabled duplicate', 'other', 1, 0),
        r('mytyrescartlink', 'Order at the shop', 'other', 5),
      ],
    });
    // Another workspace's reply must never show here
    await prisma.quickReply.create({ data: { workspaceId: B.workspaceId, shortcut: 'tyrescart', description: 'B only', category: 'other' } });
  });

  test('"/" alone lists the workspace\'s enabled replies in their sort order; disabled ones are hidden', async () => {
    assert.deepEqual(await shortcuts(), ['mytyrescartlink', 'Stockcheck', 'Wheelalignment', 'greetings', 'tyrescart', 'Insurance Quote']);
    assert.deepEqual(await shortcuts('', agentToken), await shortcuts()); // agents use them too
  });

  test('"/tyrescart": case-insensitive partial match on shortcut, text and category; exact shortcut first', async () => {
    assert.deepEqual(await shortcuts('tyrescart'), ['tyrescart', 'mytyrescartlink', 'greetings']);
    assert.deepEqual(await shortcuts('TYRESCART'), ['tyrescart', 'mytyrescartlink', 'greetings']);
    assert.deepEqual(await shortcuts('tyresc'), ['tyrescart', 'mytyrescartlink', 'greetings']); // starts-with before contains
    assert.deepEqual(await shortcuts('stock'), ['Stockcheck']); // shortcut and text
    assert.deepEqual(await shortcuts('car_services'), ['Wheelalignment']); // category
    assert.deepEqual(await shortcuts('car services'), ['Wheelalignment']); // as the menu shows it ("car services")
    assert.deepEqual(await shortcuts('CAR  SERVICES'), ['Wheelalignment']);
    assert.deepEqual(await shortcuts('car insurance'), ['Insurance Quote']);
    assert.deepEqual(await shortcuts('  ALIGN '), ['Wheelalignment']); // trimmed
    assert.deepEqual(await shortcuts('nothing-like-this'), []);
  });

  test('% and _ are matched literally, results can be limited, and input is validated', async () => {
    assert.deepEqual(await shortcuts('100%'), ['Insurance Quote']);
    assert.deepEqual(await shortcuts('d_'), ['Insurance Quote']); // "covered_", not any "d" + one character
    assert.deepEqual(await shortcuts('%'), ['Insurance Quote']); // only the reply that really contains "%"
    assert.deepEqual(await shortcuts('\\'), []); // a backslash is just a character too
    assert.deepEqual(await shortcuts(null, ws.token, 2), ['mytyrescartlink', 'Stockcheck']);
    assert.equal(await errorCode(Q, { s: 'x'.repeat(101) }, ws.token), 'BAD_USER_INPUT');
    assert.equal(await errorCode(Q, { f: 0 }, ws.token), 'BAD_USER_INPUT');
  });

  test('workspace isolation and sign-in are enforced', async () => {
    assert.deepEqual((await ok(Q, { s: 'tyrescart' }, B.token)).quickReplies.map((r: any) => r.description), ['B only']);
    assert.equal((await gql(Q, { s: 'tyrescart' })).errors?.[0].extensions?.code, 'UNAUTHENTICATED');
  });
});

describe('multi-line messages (Shift+Enter and quick replies)', () => {
  const FIELDS = 'id body status';
  let ws: { token: string; workspaceId: string };
  let conversationId: string;

  before(async () => {
    ws = await newWorkspace('multiline');
    await prisma.whatsAppAccount.create({
      data: { workspaceId: ws.workspaceId, wabaId: 'w', phoneNumberId: `pn-multiline-${run}`, accessToken: 'fake-token-e2e' },
    });
    await ok(SIMULATE, { i: { waId: '917800000001', name: 'Lines', body: 'hours?' } }, ws.token); // opens the 24h window
    conversationId = (await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes[0].id;
  });

  test('line breaks are stored and returned exactly, when sending and when editing', async () => {
    // Like the "Hours" quick reply: several lines, including an empty one
    const body = "We're currently open\nOur business hours are:\n\nThursday: 09:00 - 18:00\nSunday: Closed";
    const sent = (await ok(`mutation($i: SendTextInput!) { sendTextMessage(input: $i) { ${FIELDS} } }`, { i: { conversationId, body } }, ws.token)).sendTextMessage;
    assert.equal(sent.body, body); // Meta refuses the fake number, but the message is saved as typed
    const page = (await ok(MESSAGES, { id: conversationId }, ws.token)).messages.nodes;
    assert.equal(page.find((m: any) => m.id === sent.id).body, body);

    const edited = (await ok(`mutation($i: EditMessageInput!) { editMessage(input: $i) { body } }`, { i: { messageId: sent.id, body: `  Line one\nLine two\n` , version: 0 } }, ws.token)).editMessage;
    assert.equal(edited.body, 'Line one\nLine two'); // only the ends are trimmed; inner line breaks stay
  });
});

describe('emojis (utf8mb4) survive storage, the API, quick replies and sending', () => {
  // 4-byte emojis, a flag (two code points), a ZWJ sequence, a variation selector, and 3-byte symbols
  const EMOJI = 'Welcome 😊🤗🚘🇦🇪 👨‍🔧 🛡️ ✅ ☎️ — بطاريات';
  let ws: { token: string; workspaceId: string };
  let conversationId: string;

  before(async () => {
    ws = await newWorkspace('emoji');
    await prisma.whatsAppAccount.create({ data: { workspaceId: ws.workspaceId, wabaId: 'w', phoneNumberId: `pn-emoji-${run}`, accessToken: 'fake-token-e2e' } });
    await ok(SIMULATE, { i: { waId: '917900000009', name: 'Emoji 🚗 Customer', body: 'Hi 👋' } }, ws.token);
    conversationId = (await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes[0].id;
  });

  test('the dump parser keeps emojis exactly, and keeps "?" from damaged exports as-is (never guesses)', () => {
    const sql = `INSERT INTO \`klever_tyres_chat\` (\`id\`, \`shortcut\`, \`description\`, \`category\`, \`created_by\`, \`updated_by\`, \`status\`, \`sort_order\`, \`created_at\`, \`updated_at\`) VALUES
(1, 'ok', '${EMOJI}', 'other', NULL, NULL, 1, 1, NULL, NULL),
(2, 'damaged', 'Just to let you know ?\\n\\n?️ Insurance\\n? Battery', 'other', NULL, NULL, 1, 2, NULL, NULL);`;
    const [good, damaged] = parseQuickReplyDump(sql);
    assert.equal(good.description, EMOJI);
    assert.ok(Buffer.from(good.description!).equals(Buffer.from(EMOJI)));
    assert.equal(damaged.description, 'Just to let you know ?\n\n?️ Insurance\n? Battery');
  });

  test('lost-emoji detection: flags "?" left by a 3-byte connection, not real question marks', () => {
    assert.equal(possibleLostEmojis('Just to let you know ?\n\n?️ Insurance\n? Battery'), 3);
    assert.equal(possibleLostEmojis('Could you share it with us?\n\n? Car Make'), 1);
    assert.equal(possibleLostEmojis('How can we help? Is it urgent?'), 0);
    assert.equal(possibleLostEmojis(EMOJI), 0);
    assert.equal(possibleLostEmojis(null), 0);
  });

  test('quick replies: emojis stored, returned by the API, and searchable exactly', async () => {
    await prisma.quickReply.createMany({
      data: [
        { workspaceId: ws.workspaceId, shortcut: 'welcome😊', description: EMOJI, category: 'other', sortOrder: 1 },
        { workspaceId: ws.workspaceId, shortcut: 'plain', description: 'No emoji here', category: 'other', sortOrder: 2 },
        { workspaceId: ws.workspaceId, shortcut: 'hug', description: 'Thanks 🤗', category: 'other', sortOrder: 3 },
      ],
    });
    const stored = await prisma.quickReply.findFirstOrThrow({ where: { workspaceId: ws.workspaceId, shortcut: 'welcome😊' } });
    assert.equal(stored.description, EMOJI);
    const hex = (await prisma.$queryRaw<any[]>`SELECT HEX(description) h FROM klever_tyres_chat WHERE id = ${stored.id}`)[0].h;
    assert.equal(hex, Buffer.from(EMOJI).toString('hex').toUpperCase()); // the bytes on disk, not just the round trip

    const Q = `query($s: String) { quickReplies(search: $s) { shortcut description } }`;
    const all = (await ok(Q, { s: null }, ws.token)).quickReplies;
    assert.equal(all.find((r: any) => r.shortcut === 'welcome😊').description, EMOJI);
    assert.deepEqual((await ok(Q, { s: '🤗' }, ws.token)).quickReplies.map((r: any) => r.shortcut).sort(), ['hug', 'welcome😊']);
    assert.deepEqual((await ok(Q, { s: '🇦🇪' }, ws.token)).quickReplies.map((r: any) => r.shortcut), ['welcome😊']);
    assert.deepEqual((await ok(Q, { s: 'welcome😊' }, ws.token)).quickReplies[0].shortcut, 'welcome😊');
  });

  test('sending and editing a message keeps emojis (the inserted quick reply text is sent as-is)', async () => {
    const sent = (await ok(`mutation($i: SendTextInput!) { sendTextMessage(input: $i) { id body } }`, { i: { conversationId, body: EMOJI } }, ws.token)).sendTextMessage;
    assert.equal(sent.body, EMOJI);
    const hex = (await prisma.$queryRaw<any[]>`SELECT HEX(body) h FROM Message WHERE id = ${sent.id}`)[0].h;
    assert.equal(hex, Buffer.from(EMOJI).toString('hex').toUpperCase());
    const listed = (await ok(MESSAGES, { id: conversationId }, ws.token)).messages.nodes;
    assert.equal(listed.find((m: any) => m.id === sent.id).body, EMOJI);
    assert.equal(listed.find((m: any) => m.direction === 'in').body, 'Hi 👋'); // incoming too
    const edited = (await ok(`mutation($i: EditMessageInput!) { editMessage(input: $i) { body } }`, { i: { messageId: sent.id, body: `${EMOJI} 🔧`, version: 0 } }, ws.token)).editMessage;
    assert.equal(edited.body, `${EMOJI} 🔧`);
    const contact = (await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes[0].contact;
    assert.equal(contact.name, 'Emoji 🚗 Customer');
  });
});

describe('regression: "Welcome TyresCart.ae Customer" quick reply (emojis lost before export)', () => {
  // The row exactly as it is in klever_tyres_chat.sql (id 53 there). Its "?" are already plain 0x3F bytes.
  const DUMP_ROW = "INSERT INTO `klever_tyres_chat` (`id`, `shortcut`, `description`, `category`, `created_by`, `updated_by`, `status`, `sort_order`, `created_at`, `updated_at`) VALUES\n(53, 'Welcome TyresCart.ae Customer', 'Welcome to TyresCart.ae \\n\\nWe’re more than just Tyres — we’ve got your car covered with:\\n\\n? Car Tyres having all major Brands \\n?️ Car Insurance (3rd Party & Comprehensive)\\n? Battery Replacement & Emergency Service\\n? Brake Pad Replacement & Service\\n?️ Essential Quick Car Services (Oil/AC/etc)\\n\\n? Need help anytime? Just drop us a message — Happy to assist ?', 'other', NULL, 6, 1, 52, '2026-07-16 15:38:15', '2026-07-22 12:17:56');";
  let ws: { token: string; workspaceId: string };

  before(async () => {
    ws = await newWorkspace('welcome-regression');
  });

  test('parsed byte-for-byte from the dump, with its 7 lost emojis flagged and no emoji invented', () => {
    const [r] = parseQuickReplyDump(DUMP_ROW);
    assert.deepEqual([r.shortcut, r.category, r.status, r.sortOrder, Number(r.updatedBy)], ['Welcome TyresCart.ae Customer', 'other', 1, 52, 6]);
    assert.ok(r.description!.startsWith('Welcome to TyresCart.ae \n\nWe\u2019re more than just Tyres'));
    assert.equal(possibleLostEmojis(r.description), 7);
    assert.equal((r.description!.match(/\?/g) ?? []).length, 8); // 7 lost emojis + the real "anytime?"
    assert.equal((r.description!.match(/\?\uFE0F/g) ?? []).length, 2); // leftover variation selectors: the 3-byte-connection fingerprint
    assert.ok(!/\p{Extended_Pictographic}/u.test(r.description!)); // nothing for the app to recover
  });

  test('stored and returned by the API exactly as imported: the app neither drops nor guesses characters', async () => {
    const [r] = parseQuickReplyDump(DUMP_ROW);
    await prisma.quickReply.create({ data: { ...r, workspaceId: ws.workspaceId } });
    const api = (await ok(`query($s: String) { quickReplies(search: $s) { shortcut description } }`, { s: 'Welcome TyresCart' }, ws.token)).quickReplies;
    assert.equal(api[0].shortcut, 'Welcome TyresCart.ae Customer');
    assert.ok(Buffer.from(api[0].description).equals(Buffer.from(r.description!)));
  });

  test('once the original text is restored, emojis in those places come through intact', async () => {
    // Placeholders only (the real emojis must come from the original reply); 4-byte, with variation selectors
    const [r] = parseQuickReplyDump(DUMP_ROW);
    const restored = r.description!.replace(/\?\uFE0F/g, '\u{1F6E1}\uFE0F').replace(/(^|\n)\? /g, '$1\u{1F697} ').replace(/assist \?$/, 'assist \u{1F60A}');
    assert.equal(possibleLostEmojis(restored), 0);
    const saved = await prisma.quickReply.create({ data: { ...r, shortcut: 'Welcome restored', description: restored, workspaceId: ws.workspaceId } });
    const back = (await ok(`query($s: String) { quickReplies(search: $s) { description } }`, { s: 'Welcome restored' }, ws.token)).quickReplies[0].description;
    assert.ok(Buffer.from(back).equals(Buffer.from(restored)));
    const hex = (await prisma.$queryRaw<any[]>`SELECT HEX(description) h FROM klever_tyres_chat WHERE id = ${saved.id}`)[0].h;
    assert.equal(hex, Buffer.from(restored).toString('hex').toUpperCase()); // 4-byte emojis on disk (utf8mb4)
  });
});

describe('assignment audit fixes: link/unlink/delete rights, login workspace, assigning several chats', () => {
  type U = { id: string; token: string; email: string };
  const CREATE = `mutation($i: CreateAssigneeInput!) { createAssignee(input: $i) { id name color userId } }`;
  const UPDATE = `mutation($id: ID!, $i: UpdateAssigneeInput!) { updateAssignee(id: $id, input: $i) { id name color userId } }`;
  const DELETE = `mutation($id: ID!) { deleteAssignee(id: $id) }`;
  const TO_MEMBER = `mutation($c: ID!, $m: ID) { assignConversation(conversationId: $c, memberId: $m) { assignee { id userId } } }`;
  let ws: { token: string; workspaceId: string };
  let sup: U;
  let granted: U; // agent with the label-management grant
  let agent: U;
  const chats: string[] = [];

  async function member(name: string, role: string): Promise<U> {
    const email = `e2e-auditfix-${name.toLowerCase()}-${run}@example.com`;
    const user = await prisma.user.create({
      data: { name, email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role, workspaceId: ws.workspaceId } } },
    });
    created.userIds.push(user.id);
    const { login } = await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } });
    return { id: user.id, token: login.token, email };
  }

  before(async () => {
    ws = await newWorkspace('auditfix');
    sup = await member('Sumi', 'supervisor');
    granted = await member('Gopal', 'agent');
    agent = await member('Anil', 'agent');
    await ok(`mutation($u: ID!) { setLabelPermission(userId: $u, canManageLabels: true) { userId } }`, { u: granted.id }, ws.token);
    for (const n of [1, 2, 3, 4]) await ok(SIMULATE, { i: { waId: `91780000010${n}`, name: `Bulk ${n}`, body: 'hi' } }, ws.token);
    chats.push(...(await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes.map((c: any) => c.id));
  });

  test('a label grant covers names and colours only: linking, unlinking, relinking and deleting need supervisor/admin', async () => {
    // Allowed with the grant
    const desk = (await ok(CREATE, { i: { name: 'Night desk', color: '#123456' } }, granted.token)).createAssignee;
    assert.equal((await ok(UPDATE, { id: desk.id, i: { name: 'Night desk 2', color: '#654321' } }, granted.token)).updateAssignee.name, 'Night desk 2');
    // Refused, and nothing changes
    assert.equal(await errorCode(CREATE, { i: { name: 'Mine', color: '#000000', userId: granted.id } }, granted.token), 'FORBIDDEN');
    assert.equal(await prisma.assignee.count({ where: { workspaceId: ws.workspaceId, name: 'Mine' } }), 0);
    assert.equal(await errorCode(UPDATE, { id: desk.id, i: { userId: granted.id } }, granted.token), 'FORBIDDEN'); // link to self

    const supDesk = (await ok(TO_MEMBER, { c: chats[0], m: sup.id }, sup.token)).assignConversation.assignee; // Sumi's chat
    assert.equal(await errorCode(UPDATE, { id: supDesk.id, i: { userId: null } }, granted.token), 'FORBIDDEN'); // unlink
    assert.equal(await errorCode(UPDATE, { id: supDesk.id, i: { userId: granted.id } }, granted.token), 'FORBIDDEN'); // relink to self
    assert.equal(await errorCode(DELETE, { id: supDesk.id }, granted.token), 'FORBIDDEN'); // would unassign her chats
    assert.equal(await errorCode(DELETE, { id: desk.id }, granted.token), 'FORBIDDEN');
    const still = await prisma.assignee.findUniqueOrThrow({ where: { id: supDesk.id } });
    assert.equal(still.userId, sup.id);
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: chats[0] } })).assignedToId, supDesk.id);
    assert.deepEqual((await ok(`{ conversations(assignee: "me") { nodes { id } } }`, undefined, granted.token)).conversations.nodes, []);
    // Saving the form without changing the link is fine (the UI always sends the current link)
    assert.equal((await ok(UPDATE, { id: supDesk.id, i: { color: '#1d4ed8', userId: sup.id } }, granted.token)).updateAssignee.userId, sup.id);

    // Supervisors can do all of it
    assert.equal((await ok(UPDATE, { id: desk.id, i: { userId: agent.id } }, sup.token)).updateAssignee.userId, agent.id);
    assert.equal((await ok(UPDATE, { id: desk.id, i: { userId: null } }, sup.token)).updateAssignee.userId, null);
    assert.equal((await ok(DELETE, { id: desk.id }, sup.token)).deleteAssignee, desk.id);
  });

  test('assigning several chats to one person: counts, My Chats and the agent rules', async () => {
    for (const c of chats.slice(1, 4)) await ok(TO_MEMBER, { c, m: agent.id }, sup.token);
    const mine = (await ok(`{ conversations(assignee: "me") { nodes { id } } }`, undefined, agent.token)).conversations.nodes.map((c: any) => c.id).sort();
    assert.deepEqual(mine, chats.slice(1, 4).sort());
    const counts = (await ok(`{ assignees { userId conversationCount } }`, undefined, sup.token)).assignees;
    assert.equal(counts.find((a: any) => a.userId === agent.id).conversationCount, 3);
    // An agent picking chats for themselves: only unassigned ones
    await ok(`mutation($c: ID!) { assignConversation(conversationId: $c, assigneeId: null) { id } }`, { c: chats[3] }, agent.token); // release one
    assert.equal((await ok(TO_MEMBER, { c: chats[3], m: granted.id }, granted.token)).assignConversation.assignee.userId, granted.id);
    assert.equal(await errorCode(TO_MEMBER, { c: chats[1], m: granted.id }, granted.token), 'FORBIDDEN'); // Anil's chat
    assert.equal(await errorCode(TO_MEMBER, { c: chats[2], m: agent.id }, granted.token), 'FORBIDDEN'); // for someone else
  });

  test('login opens the remembered workspace if you belong to it, otherwise the first one you joined', async () => {
    const LOGIN = `mutation($i: LoginInput!) { login(input: $i) { workspace { id } } }`;
    const own = await newWorkspace('auditfix-own'); // Sumi will also join this one
    await prisma.member.create({ data: { userId: sup.id, workspaceId: own.workspaceId, role: 'agent' } });
    const as = (workspaceId?: string | null) => ok(LOGIN, { i: { email: sup.email, password: 'password123', workspaceId } });
    assert.equal((await as()).login.workspace.id, ws.workspaceId); // first joined
    assert.equal((await as(own.workspaceId)).login.workspace.id, own.workspaceId);
    assert.equal((await as(ws.workspaceId)).login.workspace.id, ws.workspaceId);
    assert.equal((await as(B.workspaceId)).login.workspace.id, ws.workspaceId); // not a member there: ignored
    assert.equal((await as('nonsense')).login.workspace.id, ws.workspaceId);
    assert.equal(await errorCode(LOGIN, { i: { email: sup.email, password: 'wrong-password', workspaceId: own.workspaceId } }), 'INVALID_CREDENTIALS');
    const { workspaces } = await ok(`{ workspaces { id name createdAt } }`, undefined, sup.token);
    assert.ok(workspaces.every((w: any) => w.createdAt)); // the switcher uses this to tell same-named workspaces apart
  });
});

describe('Assign dropdown: live members with email and role, Unassigned, workspace isolation', () => {
  type U = { id: string; token: string; email: string };
  const MEMBERS = `{ workspaceMembers { id name email role } }`;
  const TO_MEMBER = `mutation($c: ID!, $m: ID) { assignConversation(conversationId: $c, memberId: $m) { id assignee { id name userId user { id name email role } } } }`;
  const UNASSIGN = `mutation($c: ID!) { assignConversation(conversationId: $c, assigneeId: null) { id assignee { id } } }`;
  let ws: { token: string; workspaceId: string };
  let owner: U;
  let admin: U;
  let sup: U;
  let agent: U;
  let other: U;
  let conv: string;

  async function member(name: string, role: string): Promise<U> {
    const email = `e2e-dropdown-${name.toLowerCase()}-${run}@example.com`;
    const user = await prisma.user.create({
      data: { name, email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role, workspaceId: ws.workspaceId } } },
    });
    created.userIds.push(user.id);
    const { login } = await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } });
    return { id: user.id, token: login.token, email };
  }

  before(async () => {
    ws = await newWorkspace('dropdown');
    const me = (await ok(`{ me { user { id email } } }`, undefined, ws.token)).me.user;
    owner = { id: me.id, token: ws.token, email: me.email };
    admin = await member('Aditi', 'admin');
    sup = await member('Sanjay', 'supervisor');
    agent = await member('Arjun', 'agent');
    other = await member('Bela', 'agent');
    await ok(SIMULATE, { i: { waId: '917820000001', name: 'Dropdown chat', body: 'hi' } }, ws.token);
    conv = (await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes[0].id;
  });

  test('members come live from the current workspace with name, email and role (all roles; the UI lists Supervisors and Agents)', async () => {
    const list = (await ok(MEMBERS, undefined, agent.token)).workspaceMembers;
    assert.deepEqual(
      list.map((m: any) => [m.name, m.email, m.role]),
      [
        ['Aditi', admin.email, 'admin'],
        ['Arjun', agent.email, 'agent'],
        ['Bela', other.email, 'agent'],
        ['dropdown', owner.email, 'owner'],
        ['Sanjay', sup.email, 'supervisor'],
      ],
    );
    // A role change shows on the next fetch (the menu refetches on open and on member:permissions)
    await ok(`mutation($u: ID!) { updateMemberRole(userId: $u, role: "supervisor") { role } }`, { u: other.id }, owner.token);
    assert.equal((await ok(MEMBERS, undefined, agent.token)).workspaceMembers.find((m: any) => m.id === other.id).role, 'supervisor');
    await ok(`mutation($u: ID!) { updateMemberRole(userId: $u, role: "agent") { role } }`, { u: other.id }, owner.token);
  });

  test('workspace isolation: other workspaces never see these members or their emails', async () => {
    const fromB = (await ok(MEMBERS, undefined, B.token)).workspaceMembers;
    assert.ok(!fromB.some((m: any) => [admin.id, sup.id, agent.id, other.id, owner.id].includes(m.id)));
    assert.ok(!fromB.some((m: any) => m.email.startsWith('e2e-dropdown-')));
    assert.equal((await gql(MEMBERS)).errors?.[0].extensions?.code, 'UNAUTHENTICATED');
    assert.equal(await errorCode(TO_MEMBER, { c: conv, m: agent.id }, B.token), 'NOT_FOUND'); // B can't reach this chat
  });

  test('assign to a Supervisor or Agent, then Unassigned; the linked person (with email) comes back on the chat', async () => {
    let r = (await ok(TO_MEMBER, { c: conv, m: agent.id }, sup.token)).assignConversation.assignee;
    assert.deepEqual(r.user, { id: agent.id, name: 'Arjun', email: agent.email, role: 'agent' });
    r = (await ok(TO_MEMBER, { c: conv, m: sup.id }, admin.token)).assignConversation.assignee;
    assert.deepEqual([r.userId, r.user.role], [sup.id, 'supervisor']);
    assert.equal((await ok(UNASSIGN, { c: conv }, admin.token)).assignConversation.assignee, null); // "Unassigned"
    const history = (await ok(`query($c: ID!) { conversationActivity(conversationId: $c) { type } }`, { c: conv }, owner.token)).conversationActivity.map((a: any) => a.type);
    assert.deepEqual(history, ['assigned', 'reassigned', 'unassigned']);
  });

  test('Unassigned for agents: only their own chat, as before', async () => {
    await ok(TO_MEMBER, { c: conv, m: other.id }, sup.token); // Bela's
    assert.equal(await errorCode(UNASSIGN, { c: conv }, agent.token), 'FORBIDDEN'); // Arjun can't release Bela's
    assert.equal((await ok(UNASSIGN, { c: conv }, other.token)).assignConversation.assignee, null); // Bela releases her own
    assert.equal((await ok(UNASSIGN, { c: conv }, other.token)).assignConversation.assignee, null); // already unassigned: no-op
  });
});

describe('Assign dropdown uses existing records: reuses the linked Assignee, never duplicates users, members or assignees', () => {
  const TO_MEMBER = `mutation($c: ID!, $m: ID) { assignConversation(conversationId: $c, memberId: $m) { assignee { id name userId } } }`;
  const UNASSIGN = `mutation($c: ID!) { assignConversation(conversationId: $c, assigneeId: null) { assignee { id } } }`;
  let ws: { token: string; workspaceId: string };
  let sup: { id: string; token: string };
  let agent: { id: string };
  let fresh: { id: string; token: string };
  const chats: string[] = [];
  const rowCounts = async () => ({
    users: await prisma.user.count(),
    members: await prisma.member.count({ where: { workspaceId: ws.workspaceId } }),
    assignees: await prisma.assignee.count({ where: { workspaceId: ws.workspaceId } }),
  });

  before(async () => {
    ws = await newWorkspace('reuse');
    const mk = async (name: string, role: string) => {
      const email = `e2e-reuse-${name.toLowerCase()}-${run}@example.com`;
      const user = await prisma.user.create({
        data: { name, email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role, workspaceId: ws.workspaceId } } },
      });
      created.userIds.push(user.id);
      return { id: user.id, token: (await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } })).login.token };
    };
    sup = await mk('Sona', 'supervisor');
    agent = await mk('Akash', 'agent');
    fresh = await mk('Farah', 'agent');
    for (const n of [1, 2, 3]) await ok(SIMULATE, { i: { waId: `91784000000${n}`, name: `Reuse ${n}`, body: 'hi' } }, ws.token);
    chats.push(...(await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes.map((c: any) => c.id));
  });

  test("an existing linked Assignee is reused as-is (its own name and colour), for every chat", async () => {
    // Set up earlier by an admin: "Akash – Tyres desk" linked to Akash
    const desk = (await ok(`mutation($i: CreateAssigneeInput!) { createAssignee(input: $i) { id } }`, { i: { name: 'Akash - Tyres desk', color: '#0f2919', userId: agent.id } }, ws.token)).createAssignee;
    const before = await rowCounts();
    for (const c of chats) {
      const a = (await ok(TO_MEMBER, { c, m: agent.id }, sup.token)).assignConversation.assignee;
      assert.deepEqual([a.id, a.name, a.userId], [desk.id, 'Akash - Tyres desk', agent.id]);
    }
    assert.deepEqual(await rowCounts(), before); // no new users, memberships or assignees
    assert.equal((await prisma.assignee.findUniqueOrThrow({ where: { id: desk.id } })).color, '#0f2919');
    const mine = (await ok(`{ conversations(assignee: "me") { nodes { id } } }`, undefined, (await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email: `e2e-reuse-akash-${run}@example.com`, password: 'password123' } })).login.token)).conversations.nodes;
    assert.equal(mine.length, 3); // My Chats
  });

  test('someone with no linked Assignee gets exactly one, once; unassigning keeps it for next time', async () => {
    const before = await rowCounts();
    const first = (await ok(TO_MEMBER, { c: chats[0], m: fresh.id }, sup.token)).assignConversation.assignee;
    const second = (await ok(TO_MEMBER, { c: chats[1], m: fresh.id }, sup.token)).assignConversation.assignee;
    assert.equal(second.id, first.id);
    assert.deepEqual(await rowCounts(), { ...before, assignees: before.assignees + 1 });
    await ok(UNASSIGN, { c: chats[0] }, sup.token);
    await ok(UNASSIGN, { c: chats[1] }, fresh.token); // Farah releases her own
    assert.deepEqual((await ok(`{ conversations(assignee: "me") { nodes { id } } }`, undefined, fresh.token)).conversations.nodes, []);
    assert.equal((await ok(TO_MEMBER, { c: chats[0], m: fresh.id }, sup.token)).assignConversation.assignee.id, first.id); // reused
    assert.deepEqual(await rowCounts(), { ...before, assignees: before.assignees + 1 });
  });
});

describe('My Chats regressions: login + workspace scoping, never by name or email, assign/reassign/unassign sync', () => {
  const MINE = `{ conversations(assignee: "me") { nodes { id unread contact { name } assignee { userId } } } }`;
  const TO_MEMBER = `mutation($c: ID!, $m: ID) { assignConversation(conversationId: $c, memberId: $m) { id } }`;
  const UNASSIGN = `mutation($c: ID!) { assignConversation(conversationId: $c, assigneeId: null) { id } }`;
  let ws1: { token: string; workspaceId: string };
  let ws2: { token: string; workspaceId: string };
  let mia: { id: string; email: string; token1: string; token2: string };
  let leo: { id: string; token: string };
  const chat: Record<string, string> = {};
  const mine = async (token: string) => (await ok(MINE, undefined, token)).conversations.nodes;
  const names = async (token: string) => (await mine(token)).map((c: any) => c.contact.name).sort();
  const login = async (email: string, workspaceId?: string) =>
    (await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123', workspaceId } })).login.token as string;

  before(async () => {
    ws1 = await newWorkspace('mc-one');
    ws2 = await newWorkspace('mc-two');
    // Mia belongs to both workspaces; Leo only to the first
    const email = `e2e-mc-mia-${run}@example.com`;
    const user = await prisma.user.create({
      data: {
        name: 'Mia', email, passwordHash: await bcrypt.hash('password123', 4),
        members: { create: [{ role: 'agent', workspaceId: ws1.workspaceId }, { role: 'agent', workspaceId: ws2.workspaceId }] },
      },
    });
    created.userIds.push(user.id);
    mia = { id: user.id, email, token1: await login(email, ws1.workspaceId), token2: await login(email, ws2.workspaceId) };
    const leoUser = await prisma.user.create({
      data: { name: 'Leo', email: `e2e-mc-leo-${run}@example.com`, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role: 'agent', workspaceId: ws1.workspaceId } } },
    });
    created.userIds.push(leoUser.id);
    leo = { id: leoUser.id, token: await login(`e2e-mc-leo-${run}@example.com`) };
    for (const [w, n] of [['917860000001', 'W1-a'], ['917860000002', 'W1-b'], ['917860000003', 'W1-c']]) await ok(SIMULATE, { i: { waId: w, name: n, body: 'hi' } }, ws1.token);
    await ok(SIMULATE, { i: { waId: '917860000009', name: 'W2-a', body: 'hi' } }, ws2.token);
    for (const t of [ws1.token, ws2.token]) for (const c of (await ok(CONVERSATIONS, {}, t)).conversations.nodes) chat[c.contact.name] = c.id;
  });

  test('only the current workspace: the same person sees each workspace\'s own chats', async () => {
    await ok(TO_MEMBER, { c: chat['W1-a'], m: mia.id }, ws1.token);
    await ok(TO_MEMBER, { c: chat['W2-a'], m: mia.id }, ws2.token);
    assert.deepEqual(await names(mia.token1), ['W1-a']);
    assert.deepEqual(await names(mia.token2), ['W2-a']);
    // One linked assignee per workspace, each with Mia's real userId
    const links = await prisma.assignee.findMany({ where: { userId: mia.id }, select: { workspaceId: true } });
    assert.deepEqual(links.map((l) => l.workspaceId).sort(), [ws1.workspaceId, ws2.workspaceId].sort());
  });

  test('never by name or email: name-only assignees called "Leo" or Mia\'s email are nobody\'s', async () => {
    // Leo has no linked assignee yet, so a name-only "Leo" can exist (names are unique per workspace)
    const asName = (await ok(`mutation { createAssignee(input: { name: "Leo", color: "#000000" }) { id } }`, undefined, ws1.token)).createAssignee;
    const asEmail = (await ok(`mutation($n: String!) { createAssignee(input: { name: $n, color: "#000000" }) { id } }`, { n: mia.email.slice(0, 50) }, ws1.token)).createAssignee;
    const raw = `mutation($c: ID!, $a: ID) { assignConversation(conversationId: $c, assigneeId: $a) { id } }`;
    await ok(raw, { c: chat['W1-b'], a: asName.id }, ws1.token);
    await ok(raw, { c: chat['W1-c'], a: asEmail.id }, ws1.token);
    assert.deepEqual(await names(mia.token1), ['W1-a']);
    assert.deepEqual(await names(leo.token), []);
    await ok(UNASSIGN, { c: chat['W1-b'] }, ws1.token);
    await ok(UNASSIGN, { c: chat['W1-c'] }, ws1.token);
  });

  test('assign -> reassign -> unassign: each step shows in the right My Chats at once, with counts and unread in sync', async () => {
    const counts = async () =>
      Object.fromEntries((await ok(`{ assignees { userId conversationCount } }`, undefined, ws1.token)).assignees.filter((a: any) => a.userId).map((a: any) => [a.userId, a.conversationCount]));
    await ok(TO_MEMBER, { c: chat['W1-b'], m: leo.id }, ws1.token); // assign
    assert.deepEqual([await names(mia.token1), await names(leo.token)], [['W1-a'], ['W1-b']]);
    assert.deepEqual(await counts(), { [mia.id]: 1, [leo.id]: 1 });
    await ok(TO_MEMBER, { c: chat['W1-b'], m: mia.id }, ws1.token); // reassign to Mia
    assert.deepEqual([await names(mia.token1), await names(leo.token)], [['W1-a', 'W1-b'], []]);
    assert.deepEqual(await counts(), { [mia.id]: 2, [leo.id]: 0 });
    await ok(SIMULATE, { i: { waId: '917860000002', name: 'W1-b', body: 'any news?' } }, ws1.token); // customer writes on W1-b
    assert.equal((await mine(mia.token1)).find((c: any) => c.contact.name === 'W1-b').unread, 2);
    await ok(UNASSIGN, { c: chat['W1-b'] }, ws1.token); // unassign
    assert.deepEqual([await names(mia.token1), await names(leo.token)], [['W1-a'], []]);
    assert.deepEqual(await counts(), { [mia.id]: 1, [leo.id]: 0 });
    // Unassigned chats are in nobody's My Chats but still in everyone's Inbox
    assert.ok((await ok(CONVERSATIONS, {}, leo.token)).conversations.nodes.some((c: any) => c.id === chat['W1-b']));
  });
});
