// End-to-end tests for the GraphQL Inbox + Settings API (and REST parity).
// Needs the API running (npm run dev) against a dev database and NODE_ENV != production.
// Run: npm run test:e2e   (API_URL defaults to http://localhost:4000)
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';
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

  test('agents without permission can use labels and assignees but not change them', async () => {
    const add = `mutation($c: ID!, $l: ID!) { addConversationLabel(conversationId: $c, labelId: $l) { labels { id color } } }`;
    const added = (await ok(add, { c: conversationId, l: label.id }, agent.token)).addConversationLabel.labels;
    assert.equal(added.find((l: any) => l.id === label.id).color, '#25d366');
    const assign = `mutation($c: ID!, $a: ID) { assignConversation(conversationId: $c, assigneeId: $a) { assignee { color } } }`;
    assert.deepEqual((await ok(assign, { c: conversationId, a: assignee.id }, agent.token)).assignConversation.assignee, { color: '#0f0f0f' });
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
    await ok(SIMULATE, { i: { waId: '915555555555', body: 'hi' } }, B.token);
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
      data: { name: 'Mate', email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role: 'agent', workspaceId: ws.workspaceId } } },
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
