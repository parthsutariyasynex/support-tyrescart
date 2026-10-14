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
import { setMemberActive, updateMemberRole } from '../src/services/members.js';
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
  await prisma.assignmentRecord.deleteMany({ where: { workspaceId } });
  await prisma.message.deleteMany({ where: { conversation: { workspaceId } } });
  await prisma.conversationLabel.deleteMany({ where: { label: { workspaceId } } });
  await prisma.label.deleteMany({ where: { workspaceId } });
  await prisma.conversation.updateMany({ where: { workspaceId }, data: { assignedToId: null } });
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
    `mutation { assignConversation(conversationId: "x", assigneeId: "x", reason: "e2e") { id } }`,
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

describe('assignees (the Assign list is the workspace members)', () => {
  const ASSIGN = `mutation($c: ID!, $a: ID) { assignConversation(conversationId: $c, assigneeId: $a, reason: "e2e") { id assignee { id name color } } }`;
  const BY_ASSIGNEE = `query($assignee: ID) { conversations(assignee: $assignee) { nodes { id assignee { name } } } }`;
  type M = { userId: string; memberId: string; token: string };
  let kiran: M;
  let zara: M;
  let ids: string[];

  async function agent(name: string, workspaceId: string): Promise<M> {
    const email = `e2e-asg-${name.toLowerCase()}-${workspaceId.slice(-4)}-${run}@example.com`;
    const user = await prisma.user.create({
      data: { name, email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role: 'agent', workspaceId } } },
      include: { members: true },
    });
    created.userIds.push(user.id);
    const { login } = await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } });
    return { userId: user.id, memberId: user.members[0].id, token: login.token };
  }

  before(async () => {
    ids = (await ok(CONVERSATIONS, {}, A.token)).conversations.nodes.map((c: any) => c.id);
    zara = await agent('Zara', A.workspaceId);
    kiran = await agent('Kiran', A.workspaceId);
  });

  test('every active member is an assignee: member id, name, role colour, sorted by name', async () => {
    const { assignees } = await ok(`{ assignees { id name color conversationCount userId user { role } } }`, undefined, A.token);
    const k = assignees.find((a: any) => a.id === kiran.memberId);
    assert.deepEqual(k, { id: kiran.memberId, name: 'Kiran', color: '#047857', conversationCount: 0, userId: kiran.userId, user: { role: 'agent' } });
    assert.deepEqual(assignees.map((a: any) => a.name), [...assignees.map((a: any) => a.name)].sort((x, y) => x.localeCompare(y)));
    assert.ok(assignees.some((a: any) => a.user.role === 'owner')); // the owner is one too
  });

  test('assign, reassign and unassign (one holder per conversation)', async () => {
    let c = (await ok(ASSIGN, { c: ids[0], a: kiran.memberId }, A.token)).assignConversation;
    assert.deepEqual(c.assignee, { id: kiran.memberId, name: 'Kiran', color: '#047857' });
    c = (await ok(ASSIGN, { c: ids[0], a: zara.memberId }, A.token)).assignConversation;
    assert.equal(c.assignee.name, 'Zara');
    await ok(ASSIGN, { c: ids[1], a: kiran.memberId }, A.token);
    await ok(ASSIGN, { c: ids[2], a: kiran.memberId }, A.token);
    c = (await ok(ASSIGN, { c: ids[2], a: null }, A.token)).assignConversation;
    assert.equal(c.assignee, null);
    const { assignees } = await ok(`{ assignees { name conversationCount } }`, undefined, A.token);
    assert.deepEqual(assignees.filter((a: any) => ['Kiran', 'Zara'].includes(a.name)), [
      { name: 'Kiran', conversationCount: 1 },
      { name: 'Zara', conversationCount: 1 },
    ]);
    assert.equal(await errorCode(ASSIGN, { c: ids[0], a: 'no-such-member' }, A.token), 'NOT_FOUND');
  });

  test('conversations can be filtered by assignee (member id)', async () => {
    const list = async (vars: object) => (await ok(BY_ASSIGNEE, vars, A.token)).conversations.nodes.map((c: any) => c.id);
    assert.deepEqual(await list({ assignee: zara.memberId }), [ids[0]]);
    assert.deepEqual(await list({ assignee: kiran.memberId }), [ids[1]]);
    const unassigned = await list({ assignee: 'unassigned' });
    assert.ok(unassigned.includes(ids[2]) && !unassigned.includes(ids[0]) && !unassigned.includes(ids[1]));
    assert.equal((await list({})).length, ids.length);
  });

  test('renaming a member updates the name on their conversations', async () => {
    await ok(`mutation($u: ID!) { updateMember(userId: $u, input: { name: "Kiran S" }) { name } }`, { u: kiran.userId }, A.token);
    const { conversation } = await ok(`query($id: ID!) { conversation(id: $id) { assignee { id name } } }`, { id: ids[1] }, A.token);
    assert.deepEqual(conversation.assignee, { id: kiran.memberId, name: 'Kiran S' });
  });

  test('workspace isolation for assignees', async () => {
    const bNames = (await ok(`{ assignees { id name } }`, undefined, B.token)).assignees;
    assert.ok(!bNames.some((a: any) => a.id === kiran.memberId));
    assert.equal(await errorCode(ASSIGN, { c: ids[0], a: kiran.memberId }, B.token), 'NOT_FOUND');
    const bMember = await prisma.member.findFirstOrThrow({ where: { workspaceId: B.workspaceId } });
    assert.equal(await errorCode(ASSIGN, { c: ids[0], a: bMember.id }, A.token), 'NOT_FOUND');
    assert.equal((await ok(BY_ASSIGNEE, { assignee: kiran.memberId }, B.token)).conversations.nodes.length, 0);
  });

  test('removing a member unassigns their conversations; others keep theirs', async () => {
    await ok(`mutation($u: ID!) { removeMember(userId: $u) }`, { u: kiran.userId }, A.token);
    const { conversation } = await ok(`query($id: ID!) { conversation(id: $id) { assignee { name } } }`, { id: ids[1] }, A.token);
    assert.equal(conversation.assignee, null);
    assert.equal(await errorCode(ASSIGN, { c: ids[1], a: kiran.memberId }, A.token), 'NOT_FOUND');
    const other = await ok(`query($id: ID!) { conversation(id: $id) { assignee { name } } }`, { id: ids[0] }, A.token);
    assert.deepEqual(other.conversation.assignee, { name: 'Zara' });
  });
});

describe('label permissions and colours', () => {
  const ME = `{ me { role canManageLabels } }`;
  const CREATE_LABEL = `mutation($i: CreateLabelInput!) { createLabel(input: $i) { id name color } }`;
  const UPDATE_LABEL = `mutation($id: ID!, $i: UpdateLabelInput!) { updateLabel(id: $id, input: $i) { id color } }`;
  const GRANT = `mutation($u: ID!, $v: Boolean!) { setLabelPermission(userId: $u, canManageLabels: $v) { userId role canManageLabels } }`;
  let agent: { id: string; token: string };
  let label: any;
  let agentMemberId: string;
  let conversationId: string;

  before(async () => {
    // An agent in workspace A without label-management permission (there's no invite flow yet)
    const email = `e2e-agent2-${run}@example.com`;
    const user = await prisma.user.create({
      data: { name: 'Agent', email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role: 'agent', workspaceId: A.workspaceId } } },
      include: { members: true },
    });
    created.userIds.push(user.id);
    const { login } = await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } });
    agent = { id: user.id, token: login.token };
    agentMemberId = user.members[0].id;
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
    // Persisted
    assert.equal((await prisma.label.findUnique({ where: { id: label.id } }))!.color, '#25d366');
  });

  test('agents without permission can use labels but not change them; assigning chats is open to them', async () => {
    const add = `mutation($c: ID!, $l: ID!) { addConversationLabel(conversationId: $c, labelId: $l) { labels { id color } } }`;
    const added = (await ok(add, { c: conversationId, l: label.id }, agent.token)).addConversationLabel.labels;
    assert.equal(added.find((l: any) => l.id === label.id).color, '#25d366');
    const assign = `mutation($c: ID!, $a: ID) { assignConversation(conversationId: $c, assigneeId: $a, reason: "e2e") { assignee { color } } }`;
    assert.deepEqual((await ok(assign, { c: conversationId, a: agentMemberId }, agent.token)).assignConversation.assignee, { color: '#047857' }); // every role assigns; the agent colour
    assert.deepEqual((await ok(assign, { c: conversationId, a: agentMemberId }, A.token)).assignConversation.assignee, { color: '#047857' }); // already theirs: no-op
    // Same colours everywhere they read labels
    const { labels } = await ok(`{ labels { id color } }`, undefined, agent.token);
    assert.equal(labels.find((l: any) => l.id === label.id).color, '#25d366');

    assert.equal(await errorCode(CREATE_LABEL, { i: { name: 'Nope', color: '#000000' } }, agent.token), 'FORBIDDEN');
    assert.equal(await errorCode(UPDATE_LABEL, { id: label.id, i: { color: '#000000' } }, agent.token), 'FORBIDDEN');
    assert.equal(await errorCode(UPDATE_LABEL, { id: label.id, i: { name: 'Renamed' } }, agent.token), 'FORBIDDEN');
    assert.equal(await errorCode(`mutation($id: ID!) { deleteLabel(id: $id) }`, { id: label.id }, agent.token), 'FORBIDDEN');
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
    await ok(`mutation($c: ID!) { claimConversation(conversationId: $c) { id } }`, { c: c.id }, B.token); // New Lead: take it before replying
    const sent = (await ok(`mutation($i: SendTextInput!) { sendTextMessage(input: $i) { ${FIELDS} } }`, { i: { conversationId: c.id, body: 'from B' } }, B.token)).sendTextMessage;
    assert.equal(sent.sentById, bUser);
    assert.equal(sent.version, 0);
    assert.equal(sent.editedAt, null);
    await prisma.whatsAppAccount.delete({ where: { workspaceId: B.workspaceId } }); // later tests expect B unconnected
    await ok(`mutation($c: ID!) { assignConversation(conversationId: $c, assigneeId: null, reason: "e2e") { id } }`, { c: c.id }, B.token); // and with nothing assigned
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
  const COUNTS = `{ conversationCounts { open closed closedWithUnread unassigned } }`;
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
    const unassigned = await prisma.conversation.count({ where: { workspaceId: A.workspaceId, assignedToId: null } });
    assert.deepEqual(counts, { open: open.length, closed: 1, closedWithUnread: 0, unassigned });
    assert.ok(unassigned > 0);
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
      // Admin: Mate assigns chats to others below (any role could; the suite checks history and events)
      data: { name: 'Mate', email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role: 'admin', workspaceId: ws.workspaceId } } },
    });
    created.userIds.push(user.id);
    mate = { id: user.id, token: (await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } })).login.token };
    await ok(SIMULATE, { i: { waId: '918888888888', name: 'Riya', body: 'Do you have 205/55 R16?' } }, ws.token);
    conv = (await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes[0].id;
  });

  test('each change is recorded once, with who did it; no-ops are not', async () => {
    const label = (await ok(`mutation { createLabel(input: { name: "Hot lead", color: "#ff3b30" }) { id } }`, undefined, ws.token)).createLabel;
    const assignee = { id: (await prisma.member.findUniqueOrThrow({ where: { userId_workspaceId: { userId: mate.id, workspaceId: ws.workspaceId } } })).id }; // Mate's membership
    const add = `mutation($c: ID!, $l: ID!) { addConversationLabel(conversationId: $c, labelId: $l) { id } }`;
    const assign = `mutation($c: ID!, $a: ID) { assignConversation(conversationId: $c, assigneeId: $a, reason: "e2e") { id } }`;
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
    assert.deepEqual(JSON.parse(timeline[2].data), { assignee: 'Mate', color: '#6d28d9', assigneeUserId: mate.id });
    assert.deepEqual(JSON.parse(timeline[3].data), { assignee: 'Mate' });
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
  const ASSIGN = `mutation($c: ID!, $a: ID) { assignConversation(conversationId: $c, assigneeId: $a, reason: "e2e") { id assignee { id name userId } } }`;
  const TAKE = `mutation($c: ID!) { claimConversation(conversationId: $c) { id assignee { id name userId } } }`;
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
  // Member ids (what assignedToId holds)
  let mAsha: string;
  let mRavi: string;
  let mSam: string;
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
    sam = await newAgent('Sam', 'admin'); // the second assigner besides the owner
    await ok(SIMULATE, { i: { waId: '917777777771', name: 'Riya', body: 'Need 4 tyres' } }, ws.token);
    await ok(SIMULATE, { i: { waId: '917777777772', name: 'Kabir', body: 'Alignment?' } }, ws.token);
    const nodes = (await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes;
    conv = nodes.find((c: any) => c.contact.name === 'Riya').id;
    conv2 = nodes.find((c: any) => c.contact.name === 'Kabir').id;
    for (const [who, a] of Object.entries({ owner, asha, ravi })) sockets[who] = await listen(a.token);
    const memberId = async (userId: string) => (await prisma.member.findUniqueOrThrow({ where: { userId_workspaceId: { userId, workspaceId: ws.workspaceId } } })).id;
    [mAsha, mRavi, mSam] = await Promise.all([memberId(asha.id), memberId(ravi.id), memberId(sam.id)]);
  });

  after(() => Object.values(sockets).forEach((s) => s.socket.disconnect()));

  test('workspaceMembers lists everyone in the workspace by name, with email and role', async () => {
    const { workspaceMembers } = await ok(`{ workspaceMembers { id name email role } }`, undefined, asha.token);
    assert.deepEqual(
      workspaceMembers.map((m: any) => [m.name, m.role]),
      [['Asha', 'agent'], ['assignflow', 'owner'], ['Ravi', 'agent'], ['Sam', 'admin']],
    );
    assert.equal(workspaceMembers.find((m: any) => m.id === asha.id).email, `e2e-assign-asha-${run}@example.com`);
    assert.ok(!(await ok(`{ workspaceMembers { id } }`, undefined, B.token)).workspaceMembers.some((m: any) => m.id === asha.id));
  });

  test('the Assign list is the members: member id, user details and role colour; nothing to link', async () => {
    const { assignees } = await ok(`{ assignees { id name color userId user { id name role } } }`, undefined, asha.token);
    assert.deepEqual(assignees.find((a: any) => a.id === mRavi), { id: mRavi, name: 'Ravi', color: '#047857', userId: ravi.id, user: { id: ravi.id, name: 'Ravi', role: 'agent' } });
    assert.equal(assignees.find((a: any) => a.id === mSam).color, '#6d28d9'); // admin colour
    assert.ok(!(await ok(`{ assignees { id } }`, undefined, B.token)).assignees.some((a: any) => a.id === mAsha));
  });

  test('Assign to Me, assign, reassign and unassign; history names the previous assignee; no-ops record nothing', async () => {
    await ok(TAKE, { c: conv }, asha.token); // Asha takes the unassigned chat
    await ok(ASSIGN, { c: conv, a: mSam }, sam.token);
    await ok(ASSIGN, { c: conv, a: mSam }, sam.token); // already Sam
    await ok(ASSIGN, { c: conv, a: mAsha }, sam.token);
    await ok(ASSIGN, { c: conv, a: mAsha }, asha.token); // already Asha: a no-op (agents may assign too)
    const c = (await ok(ASSIGN, { c: conv, a: null }, sam.token)).assignConversation;
    assert.equal(c.assignee, null);
    await ok(ASSIGN, { c: conv, a: null }, sam.token); // already unassigned

    const items = await timeline(conv);
    assert.deepEqual(
      items.map((a: any) => [a.type, a.actorName, JSON.parse(a.data)]),
      [
        ['assigned', 'Asha', { assignee: 'Asha', color: '#047857', assigneeUserId: asha.id }],
        ['reassigned', 'Sam', { assignee: 'Sam', color: '#6d28d9', previous: 'Asha', assigneeUserId: sam.id }],
        ['reassigned', 'Sam', { assignee: 'Asha', color: '#047857', previous: 'Sam', assigneeUserId: asha.id }],
        ['unassigned', 'Sam', { assignee: 'Asha' }],
      ],
    );
  });

  test('Socket.IO: one conversation:assigned per real change; assignment:you only to the linked agent, never to yourself', async () => {
    resetEvents();
    await ok(ASSIGN, { c: conv, a: mRavi }, owner.token);
    await settle();
    for (const who of ['owner', 'asha', 'ravi']) {
      const assigned = received(who, 'conversation:assigned');
      assert.equal(assigned.length, 1, `${who} should get exactly one conversation:assigned`);
      assert.deepEqual([assigned[0].conversationId, assigned[0].assignee.id, assigned[0].assignee.userId], [conv, mRavi, ravi.id]);
    }
    assert.deepEqual(
      received('ravi', 'assignment:you').map((e) => [e.conversationId, e.actorName, e.contactName, e.assignee.name]),
      [[conv, 'assignflow', 'Riya', 'Ravi']],
    );
    assert.equal(received('owner', 'assignment:you').length, 0);
    assert.equal(received('asha', 'assignment:you').length, 0);
    assert.equal(received('owner', 'activity:new').filter((a) => a.type === 'reassigned' || a.type === 'assigned').length, 1);

    resetEvents();
    await ok(ASSIGN, { c: conv, a: mRavi }, sam.token); // no change
    await settle();
    for (const who of ['owner', 'asha', 'ravi']) {
      assert.equal(received(who, 'conversation:assigned').length, 0);
      assert.equal(received(who, 'activity:new').length, 0);
    }

    resetEvents();
    await ok(TAKE, { c: conv2 }, ravi.token); // to himself: no pop-up
    await ok(ASSIGN, { c: conv2, a: null }, owner.token); // unassign: nobody is "assigned"
    await settle();
    assert.equal(received('ravi', 'assignment:you').length, 0);
    assert.deepEqual(received('asha', 'conversation:assigned').map((e) => e.assignee?.id ?? null), [mRavi, null]);
  });

  test('Socket.IO: assignment:removed tells only the agent a chat was taken from, unless they did it', async () => {
    // conv is assigned to Ravi (from the previous test)
    resetEvents();
    await ok(ASSIGN, { c: conv, a: mAsha }, owner.token); // reassign Ravi -> Asha
    await settle();
    assert.deepEqual(
      received('ravi', 'assignment:removed').map((e) => [e.conversationId, e.previous, e.assignee?.name, e.actorName, e.contactName]),
      [[conv, 'Ravi', 'Asha', 'assignflow', 'Riya']],
    );
    assert.equal(received('asha', 'assignment:you').length, 1);
    assert.equal(received('asha', 'assignment:removed').length, 0);
    assert.equal(received('owner', 'assignment:removed').length, 0);

    resetEvents();
    await ok(ASSIGN, { c: conv, a: null }, sam.token); // unassigned while Asha has it
    await ok(ASSIGN, { c: conv, a: mRavi }, owner.token);
    await ok(ASSIGN, { c: conv, a: null }, owner.token); // owner unassigns Ravi
    await ok(ASSIGN, { c: conv, a: mSam }, owner.token); // from nobody: nothing removed
    await ok(ASSIGN, { c: conv, a: mRavi }, owner.token); // taken from Sam (no listener here): Ravi only gets assignment:you
    await settle();
    assert.deepEqual(received('asha', 'assignment:removed').map((e) => [e.previous, e.assignee]), [['Asha', null]]);
    assert.deepEqual(
      received('ravi', 'assignment:removed').map((e) => [e.previous, e.assignee]),
      [['Ravi', null]],
    );
    assert.equal(received('owner', 'assignment:removed').length, 0);
  });

  test('"Assigned to me" lists only the chats held by your own membership', async () => {
    await ok(ASSIGN, { c: conv, a: mRavi }, owner.token);
    await ok(ASSIGN, { c: conv2, a: mAsha }, owner.token);
    assert.deepEqual(await mine(ravi.token), [conv]);
    assert.deepEqual(await mine(asha.token), [conv2]);
    assert.deepEqual(await mine(owner.token), []); // holds nothing
    assert.deepEqual(await mine(B.token), []);
    const counts = (await ok(`{ assignees { name conversationCount } }`, undefined, owner.token)).assignees;
    assert.deepEqual(counts.map((a: any) => [a.name, a.conversationCount]), [['Asha', 1], ['assignflow', 0], ['Ravi', 1], ['Sam', 0]]);
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
    await ok(ASSIGN, { c: conv, a: mSam }, owner.token);
    const before = (await timeline(conv)).length;
    const targets = [mAsha, mRavi, mSam, mAsha, mRavi, mAsha];
    const tokens = [owner.token, sam.token]; // owners and admins reassign; nobody else can
    const results = await Promise.all(targets.map((t, i) => gql(ASSIGN, { c: conv, a: t }, tokens[i % tokens.length])));
    for (const r of results) assert.ok(!r.errors || r.errors[0].extensions?.code === 'ASSIGN_CONFLICT', JSON.stringify(r.errors));

    const final = (await ok(`query($id: ID!) { conversation(id: $id) { assignee { name } } }`, { id: conv }, owner.token)).conversation.assignee.name;
    const changes = (await timeline(conv)).slice(before).map((a: any) => {
      assert.equal(a.type, 'reassigned');
      const d = JSON.parse(a.data);
      return [d.previous, d.assignee] as [string, string];
    });
    // The recorded changes must chain from "Sam" to the final assignee using every change exactly once
    const chains = (from: string, left: [string, string][]): boolean =>
      left.length === 0
        ? from === final
        : left.some(([p, n], i) => p === from && chains(n, left.filter((_, j) => j !== i)));
    assert.ok(chains('Sam', changes), `history ${JSON.stringify(changes)} does not end at ${final}`);
  });

  test('removing a member unassigns their chats and records it in each chat; deleting a user account does the same', async () => {
    const temp = await newAgent('Temp');
    const mTemp = (await prisma.member.findUniqueOrThrow({ where: { userId_workspaceId: { userId: temp.id, workspaceId: ws.workspaceId } } })).id;
    await ok(ASSIGN, { c: conv, a: mTemp }, owner.token);
    await ok(ASSIGN, { c: conv2, a: mTemp }, owner.token);
    await settle();
    resetEvents();
    await ok(`mutation($u: ID!) { removeMember(userId: $u) }`, { u: temp.id }, owner.token);
    await settle();
    for (const c of [conv, conv2]) {
      const last = (await timeline(c)).at(-1);
      assert.deepEqual([last.type, last.actorName, JSON.parse(last.data)], ['unassigned', 'assignflow', { assignee: 'Temp', reason: 'member_removed' }]);
    }
    assert.deepEqual(received('asha', 'assignee:deleted'), [{ id: mTemp }]);
    assert.equal(received('asha', 'activity:new').filter((a) => a.type === 'unassigned').length, 2);
    assert.equal(await errorCode(ASSIGN, { c: conv, a: mTemp }, owner.token), 'NOT_FOUND');

    const temp2 = await newAgent('Temp2');
    const mTemp2 = (await prisma.member.findUniqueOrThrow({ where: { userId_workspaceId: { userId: temp2.id, workspaceId: ws.workspaceId } } })).id;
    await ok(ASSIGN, { c: conv, a: mTemp2 }, owner.token);
    await prisma.user.delete({ where: { id: temp2.id } }); // account gone: membership cascades, the chat is unassigned
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: conv } })).assignedToId, null);
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
  const ASSIGN = `mutation($c: ID!, $a: ID) { assignConversation(conversationId: $c, assigneeId: $a, reason: "e2e") { assignee { name } } }`;
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
    assert.ok((await ok(`{ members { status } }`, undefined, ws.token)).members.every((m: any) => m.status === 'active')); // all signed up with a password
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
    const desk = await prisma.member.findUniqueOrThrow({ where: { userId_workspaceId: { userId: gone.id, workspaceId: ws.workspaceId } } }); // her membership
    await ok(ASSIGN, { c: conv, a: desk.id }, admin.token); // Gita holds a chat when she is removed
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
    // Her name is gone from the Assign list and her chat is back in New Leads, with a history entry
    assert.equal(await prisma.member.findUnique({ where: { id: desk.id } }), null);
    assert.ok(!(await ok(`{ assignees { id } }`, undefined, admin.token)).assignees.some((a: any) => a.id === desk.id));
    assert.equal((await ok(`query($id: ID!) { conversation(id: $id) { assignee { id } } }`, { id: conv }, admin.token)).conversation.assignee, null);
    const last = (await ok(`query($c: ID!) { conversationActivity(conversationId: $c) { type data } }`, { c: conv }, admin.token)).conversationActivity.at(-1);
    assert.deepEqual([last.type, JSON.parse(last.data)], ['unassigned', { assignee: 'Gita', reason: 'member_removed' }]);
    assert.ok((await ok(`{ conversations(assignee: "unassigned") { nodes { id } } }`, undefined, admin.token)).conversations.nodes.some((c: any) => c.id === conv));
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

  test('assignments by role: every role assigns, reassigns and unassigns; Assign to Me only takes an unassigned chat', async () => {
    const TAKE = `mutation($c: ID!) { claimConversation(conversationId: $c) { assignee { name } } }`;
    const mk = async (userId: string) => (await prisma.member.findUniqueOrThrow({ where: { userId_workspaceId: { userId, workspaceId: ws.workspaceId } } })).id;
    const amanDesk = await mk(agent.id); // memberships, named after the people
    const saraDesk = await mk(sup.id);
    const pool = await mk(owner.id);

    assert.equal((await ok(ASSIGN, { c: conv, a: pool }, agent.token)).assignConversation.assignee.name, 'roles'); // an agent assigns to someone else
    assert.equal((await ok(ASSIGN, { c: conv, a: amanDesk }, agent.token)).assignConversation.assignee.name, 'Aman'); // and to himself
    assert.equal((await ok(ASSIGN, { c: conv, a: null }, agent.token)).assignConversation.assignee, null); // and releases
    assert.equal((await ok(TAKE, { c: conv }, agent.token)).claimConversation.assignee.name, 'Aman'); // Assign to Me
    assert.equal((await ok(ASSIGN, { c: conv, a: saraDesk }, sup.token)).assignConversation.assignee.name, 'Sara'); // a supervisor takes it over
    assert.equal(await errorCode(TAKE, { c: conv }, agent.token), 'ALREADY_ASSIGNED'); // Assign to Me never takes someone else's chat
    assert.equal((await ok(ASSIGN, { c: conv, a: null }, sup.token)).assignConversation.assignee, null); // supervisors release too
    await ok(ASSIGN, { c: conv, a: saraDesk }, admin.token);
    assert.equal((await ok(ASSIGN, { c: conv, a: null }, agent.token)).assignConversation.assignee, null); // an agent releases someone else's
    assert.equal((await ok(ASSIGN, { c: conv, a: amanDesk }, admin.token)).assignConversation.assignee.name, 'Aman'); // admin reassigns
    assert.equal((await ok(ASSIGN, { c: conv, a: pool }, admin.token)).assignConversation.assignee.name, 'roles');
    // A label grant changes nothing here either
    await ok(`mutation($u: ID!) { setLabelPermission(userId: $u, canManageLabels: true) { userId } }`, { u: agent.id }, admin.token);
    assert.equal((await ok(ASSIGN, { c: conv, a: amanDesk }, agent.token)).assignConversation.assignee.name, 'Aman');
    assert.equal((await ok(ASSIGN, { c: conv, a: pool }, admin.token)).assignConversation.assignee.name, 'roles');
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
  const TO_MEMBER = `mutation($c: ID!, $m: ID) { assignConversation(conversationId: $c, memberId: $m, reason: "e2e") { id assignee { id name color userId } } }`;
  const TO_ASSIGNEE = `mutation($c: ID!, $a: ID) { assignConversation(conversationId: $c, assigneeId: $a, reason: "e2e") { id assignee { id name userId } } }`;
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

  test('anyone assigns to either role; the person is one membership in their role colour', async () => {
    const bySup = (await ok(TO_MEMBER, { c: c1, m: agent.id }, sup.token)).assignConversation.assignee; // a supervisor assigns
    assert.deepEqual([bySup.name, bySup.userId], ['Arun', agent.id]);
    const r = (await ok(TO_MEMBER, { c: c1, m: agent.id }, owner.token)).assignConversation.assignee; // already his: no-op
    assert.deepEqual([r.name, r.color, r.userId], ['Arun', '#047857', agent.id]);
    const again = (await ok(TO_MEMBER, { c: c2, m: agent.id }, owner.token)).assignConversation.assignee;
    assert.equal(again.id, r.id); // reused, not duplicated
    const toSup = (await ok(TO_MEMBER, { c: c1, m: sup.id }, owner.token)).assignConversation.assignee; // reassign to a supervisor
    assert.deepEqual([toSup.name, toSup.color, toSup.userId], ['Sana', '#1d4ed8', sup.id]);
    assert.equal((await ok(TO_MEMBER, { c: c1, m: agent.id }, owner.token)).assignConversation.assignee.userId, agent.id); // and back

    // Counts, filters and "Assigned to me" work exactly as for any assignee
    const counts = (await ok(`{ assignees { name userId conversationCount } }`, undefined, owner.token)).assignees;
    assert.deepEqual(counts.filter((a: any) => ['Arun', 'Sana'].includes(a.name)).map((a: any) => [a.name, a.conversationCount]), [['Arun', 2], ['Sana', 0]]);
    assert.deepEqual((await ok(`{ conversations(assignee: "me") { nodes { id } } }`, undefined, agent.token)).conversations.nodes.map((c: any) => c.id).sort(), [c1, c2].sort());
    assert.deepEqual((await ok(`query($a: ID) { conversations(assignee: $a) { nodes { id } } }`, { a: r.id }, owner.token)).conversations.nodes.length, 2);
  });

  test('agents assign too: to someone else, to themselves and release; Assign to Me only takes an unassigned chat', async () => {
    const TAKE = `mutation($c: ID!) { claimConversation(conversationId: $c) { assignee { userId } } }`;
    assert.equal((await ok(TO_MEMBER, { c: c3, m: other.id }, agent.token)).assignConversation.assignee.userId, other.id); // Arun gives Omar the chat
    assert.equal(await errorCode(TAKE, { c: c1 }, other.token), 'ALREADY_ASSIGNED'); // Assign to Me never takes Arun's chat
    assert.equal((await ok(TO_ASSIGNEE, { c: c3, a: null }, other.token)).assignConversation.assignee, null); // Omar releases his own
    assert.equal((await ok(TAKE, { c: c3 }, other.token)).claimConversation.assignee.userId, other.id); // Assign to Me
    assert.equal((await ok(TAKE, { c: c3 }, other.token)).claimConversation.assignee.userId, other.id); // no-op
    assert.equal((await ok(TO_ASSIGNEE, { c: c3, a: null }, agent.token)).assignConversation.assignee, null); // Arun releases Omar's
    assert.equal((await ok(TO_MEMBER, { c: c3, m: other.id }, other.token)).assignConversation.assignee.userId, other.id); // Omar takes it from the Assign list
    assert.equal((await ok(TO_ASSIGNEE, { c: c3, a: null }, sup.token)).assignConversation.assignee, null); // a supervisor releases it
    assert.equal((await ok(TO_ASSIGNEE, { c: c3, a: null }, owner.token)).assignConversation.assignee, null); // already unassigned: no-op
  });

  test('any member of this workspace can be assigned, admins included; outsiders and bad input are refused', async () => {
    // Admins/owners too, so their chats show in their My Chats (purple, the admin colour)
    const toOwner = (await ok(TO_MEMBER, { c: c3, m: owner.id }, owner.token)).assignConversation.assignee;
    assert.deepEqual([toOwner.color, toOwner.userId], ['#6d28d9', owner.id]);
    await ok(TO_ASSIGNEE, { c: c3, a: null }, owner.token);
    const bUser = (await ok(`{ me { user { id } } }`, undefined, B.token)).me.user.id;
    assert.equal(await errorCode(TO_MEMBER, { c: c3, m: bUser }, owner.token), 'NOT_FOUND'); // another workspace
    assert.equal(await errorCode(TO_MEMBER, { c: c3, m: agent.id }, B.token), 'NOT_FOUND'); // their chat isn't visible to B
    const desk = await prisma.member.findUniqueOrThrow({ where: { userId_workspaceId: { userId: agent.id, workspaceId: ws.workspaceId } } }); // Arun's membership
    const both = await gql(`mutation($c: ID!, $a: ID, $m: ID) { assignConversation(conversationId: $c, assigneeId: $a, memberId: $m, reason: "e2e") { id } }`, { c: c3, a: desk.id, m: agent.id }, owner.token);
    assert.equal(both.errors?.[0].extensions?.code, 'BAD_USER_INPUT');
    // Assigning by member id works the same as by person
    assert.equal((await ok(TO_ASSIGNEE, { c: c3, a: desk.id }, owner.token)).assignConversation.assignee.name, 'Arun');
  });

  test('assigning a person: the member id is the assignee id; notifications and events as before', async () => {
    const nadia = await member('Nadia', 'agent');
    const live = connectSocket(API, { auth: { token: nadia.token }, transports: ['websocket'], forceNew: true });
    const events: { event: string; data: any }[] = [];
    live.onAny((event, data) => events.push({ event, data }));
    await new Promise<void>((resolve) => live.on('connect', () => resolve()));

    const r = (await ok(TO_MEMBER, { c: c3, m: nadia.id }, owner.token)).assignConversation.assignee;
    await new Promise((res) => setTimeout(res, 300));
    live.disconnect();
    const mNadia = (await prisma.member.findUniqueOrThrow({ where: { userId_workspaceId: { userId: nadia.id, workspaceId: ws.workspaceId } } })).id;
    assert.deepEqual([r.id, r.name, r.userId], [mNadia, 'Nadia', nadia.id]);
    assert.deepEqual(events.filter((e) => e.event === 'conversation:assigned').map((e) => e.data.assignee.id), [r.id]);
    assert.deepEqual(events.filter((e) => e.event === 'assignment:you').map((e) => [e.data.conversationId, e.data.actorName]), [[c3, 'people']]);
    assert.ok(events.some((e) => e.event === 'activity:new' && e.data.type === 'reassigned' && JSON.parse(e.data.data).previous === 'Arun'));
  });
});

describe('"Add person" from the Assign dropdown', () => {
  const INVITE = `mutation($i: InviteMemberInput!) { inviteMember(input: $i) { invited emailSent member { userId name email role status } } }`;
  const MEMBERS = `{ workspaceMembers { id name role } }`;
  const TO_MEMBER = `mutation($c: ID!, $m: ID) { assignConversation(conversationId: $c, memberId: $m, reason: "e2e") { assignee { name color userId } } }`;
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
    assert.equal((await ok(TO_MEMBER, { c: conv, m: r.member.userId }, sup.token)).assignConversation.assignee.userId, r.member.userId); // supervisors assign too
    const a = (await ok(TO_MEMBER, { c: conv, m: r.member.userId }, ws.token)).assignConversation.assignee; // already hers: no-op
    assert.deepEqual([a.name, a.color, a.userId], ['Devi', '#047857', r.member.userId]);

    // Teams tab: admins see everyone with email, role and status; the new person is "invited" until they choose a password
    const TEAM = `{ members { userId name email role status } }`;
    const team = (await ok(TEAM, undefined, ws.token)).members;
    assert.deepEqual(team.find((m: any) => m.userId === r.member.userId), { userId: r.member.userId, name: 'Devi', email, role: 'agent', status: 'invited' });
    assert.ok(team.filter((m: any) => m.userId !== r.member.userId).every((m: any) => m.status === 'active'));
    assert.equal(r.member.status, 'invited'); // the invite result says so too
    assert.equal(await errorCode(TEAM, undefined, sup.token), 'FORBIDDEN'); // supervisors (and agents) can't see the team
    assert.equal(await errorCode(TEAM, undefined), 'UNAUTHENTICATED');
    // A "forgot password" link (minutes, not days) doesn't make an active member look invited
    await prisma.passwordResetToken.create({ data: { userId: sup.id, tokenHash: `e2e-reset-${run}`, expiresAt: new Date(Date.now() + 30 * 60 * 1000) } });
    assert.equal((await ok(TEAM, undefined, ws.token)).members.find((m: any) => m.userId === sup.id).status, 'active');
    // Devi chooses a password from the invite link (exactly what resetPassword records): active from then on
    await prisma.$transaction([
      prisma.passwordResetToken.updateMany({ where: { userId: r.member.userId }, data: { usedAt: new Date() } }),
      prisma.user.update({ where: { id: r.member.userId }, data: { passwordChangedAt: new Date() } }),
    ]);
    assert.equal((await ok(TEAM, undefined, ws.token)).members.find((m: any) => m.userId === r.member.userId).status, 'active');
  });

  test('Teams tab stays live: adding, role changes and removal reach admins over Socket.IO, in order', async () => {
    const live = connectSocket(API, { auth: { token: ws.token }, transports: ['websocket'], forceNew: true });
    const events: { event: string; data: any }[] = [];
    live.onAny((event, data) => events.push({ event, data }));
    try {
      await new Promise<void>((resolve, reject) => {
        live.on('connect', () => resolve());
        live.on('connect_error', reject);
      });
      const email = `e2e-addperson-live-${run}@example.com`;
      const r = (await ok(INVITE, { i: { name: 'Lila', email, role: 'agent' } }, ws.token)).inviteMember;
      created.userIds.push(r.member.userId);
      await ok(`mutation($u: ID!, $r: String!) { updateMemberRole(userId: $u, role: $r) { role } }`, { u: r.member.userId, r: 'supervisor' }, ws.token);
      await ok(`mutation($u: ID!) { removeMember(userId: $u) }`, { u: r.member.userId }, ws.token);
      await new Promise((res) => setTimeout(res, 300));
      const forLila = events.filter((e) => e.data?.userId === r.member.userId && e.event !== 'assignee:saved').map((e) => [e.event, e.data.role ?? null]); // assignee:saved mirrors the role change for the Assign list
      assert.deepEqual(forLila, [['member:permissions', 'agent'], ['member:permissions', 'supervisor'], ['member:removed', null]]);
      assert.ok(!(await ok(`{ members { userId } }`, undefined, ws.token)).members.some((m: any) => m.userId === r.member.userId));
    } finally {
      live.disconnect();
    }
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
  const TO_MEMBER = `mutation($c: ID!, $m: ID) { assignConversation(conversationId: $c, memberId: $m, reason: "e2e") { id } }`;
  const UNASSIGN = `mutation($c: ID!) { assignConversation(conversationId: $c, assigneeId: null, reason: "e2e") { id } }`;
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
    await ok(TO_MEMBER, { c: ids.P1, m: ana.id }, sup.token); // a supervisor assigns
    await ok(TO_MEMBER, { c: ids.P1, m: ana.id }, ws.token); // already hers: no-op
    await ok(TO_MEMBER, { c: ids.P3, m: ana.id }, ws.token);
    await ok(TO_MEMBER, { c: ids.P2, m: ben.id }, ws.token);
    const list = await mine(ana.token);
    assert.deepEqual(list.map((c: any) => c.contact.name), ['P3', 'P1']); // newest first; Ben's P2 and unassigned P4 left out
    assert.ok(list.every((c: any) => c.assignee.userId === ana.id && c.unread === 1 && c.lastMessage.body.startsWith('hello from')));
    assert.deepEqual(await mineIds(ben.token), [ids.P2]);
    assert.deepEqual(await mineIds(sup.token), []); // the supervisor owns none
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

    await ok(TO_MEMBER, { c: ids.P4, m: ana.id }, ws.token); // assigned to Ana
    assert.ok((await mineIds(ana.token)).includes(ids.P4));
    await ok(TO_MEMBER, { c: ids.P1, m: ben.id }, ws.token); // reassigned away from Ana
    assert.ok(!(await mineIds(ana.token)).includes(ids.P1));
    assert.ok((await mineIds(ben.token)).includes(ids.P1));
    await ok(UNASSIGN, { c: ids.P3 }, sup.token); // a supervisor releases Ana's chat
    await ok(UNASSIGN, { c: ids.P3 }, ws.token); // already unassigned: no-op
    assert.deepEqual(await mineIds(ana.token), [ids.P4]);
    await new Promise((r) => setTimeout(r, 300));
    live.disconnect();

    const assigned = events.filter((e) => e.event === 'conversation:assigned').map((e) => [e.data.conversationId, e.data.assignee?.userId ?? null]);
    assert.deepEqual(assigned, [[ids.P4, ana.id], [ids.P1, ben.id], [ids.P3, null]]);
    assert.deepEqual(events.filter((e) => e.event === 'assignment:you').map((e) => e.data.conversationId), [ids.P4]);
    assert.deepEqual(events.filter((e) => e.event === 'assignment:removed').map((e) => e.data.conversationId), [ids.P1, ids.P3]);
  });

  test("another workspace's chats never appear, and signed-out requests are refused", async () => {
    assert.deepEqual(await mineIds(B.token), []);
    assert.equal((await gql(MINE, { l: null })).errors?.[0].extensions?.code, 'UNAUTHENTICATED');
  });
});

describe('My Chats regressions: admins, name-only assignees, same-named users', () => {
  const MINE = `{ conversations(assignee: "me") { nodes { id } } }`;
  const TO_MEMBER = `mutation($c: ID!, $m: ID) { assignConversation(conversationId: $c, memberId: $m, reason: "e2e") { assignee { id name userId } } }`;
  const TO_ASSIGNEE = `mutation($c: ID!, $a: ID) { assignConversation(conversationId: $c, assigneeId: $a, reason: "e2e") { assignee { id } } }`;
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

  test('reassigning away and unassigning take chats out of My Chats straight away', async () => {
    await ok(TO_MEMBER, { c: ids.R1, m: twin.id }, ws.token);
    assert.deepEqual(await mine(ws.token), []);
    assert.ok((await mine(twin.token)).includes(ids.R1));
    await ok(TO_ASSIGNEE, { c: ids.R1, a: null }, twin.token); // a supervisor releases their own
    await ok(TO_ASSIGNEE, { c: ids.R1, a: null }, ws.token); // already unassigned: no-op
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
    await ok(`mutation($c: ID!) { claimConversation(conversationId: $c) { id } }`, { c: conversationId }, ws.token); // take the lead before replying
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
    await ok(`mutation($c: ID!) { claimConversation(conversationId: $c) { id } }`, { c: conversationId }, ws.token); // take the lead before replying
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
    const hex = (await prisma.$queryRaw<any[]>`SELECT HEX(description) h FROM Shortchat WHERE id = ${stored.id}`)[0].h;
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
    const hex = (await prisma.$queryRaw<any[]>`SELECT HEX(description) h FROM Shortchat WHERE id = ${saved.id}`)[0].h;
    assert.equal(hex, Buffer.from(restored).toString('hex').toUpperCase()); // 4-byte emojis on disk (utf8mb4)
  });
});

describe('assignment audit fixes: link/unlink/delete rights, login workspace, assigning several chats', () => {
  type U = { id: string; token: string; email: string };
  const TO_MEMBER = `mutation($c: ID!, $m: ID) { assignConversation(conversationId: $c, memberId: $m, reason: "e2e") { assignee { id userId } } }`;
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

  test('assigning several chats to one person: counts, My Chats and the agent rules', async () => {
    await ok(TO_MEMBER, { c: chats[1], m: agent.id }, sup.token); // supervisors assign too
    for (const c of chats.slice(1, 4)) await ok(TO_MEMBER, { c, m: agent.id }, ws.token); // chats[1] again: no-op
    const mine = (await ok(`{ conversations(assignee: "me") { nodes { id } } }`, undefined, agent.token)).conversations.nodes.map((c: any) => c.id).sort();
    assert.deepEqual(mine, chats.slice(1, 4).sort());
    const counts = (await ok(`{ assignees { userId conversationCount } }`, undefined, sup.token)).assignees;
    assert.equal(counts.find((a: any) => a.userId === agent.id).conversationCount, 3);
    // Agents release and pick chats themselves; Assign to Me only takes unassigned ones
    const release = `mutation($c: ID!) { assignConversation(conversationId: $c, assigneeId: null, reason: "e2e") { id } }`;
    await ok(release, { c: chats[3] }, agent.token); // the agent releases his own
    await ok(release, { c: chats[3] }, sup.token); // already unassigned: no-ops
    await ok(release, { c: chats[3] }, ws.token);
    const take = `mutation($c: ID!) { claimConversation(conversationId: $c) { assignee { userId } } }`;
    assert.equal((await ok(TO_MEMBER, { c: chats[3], m: granted.id }, granted.token)).assignConversation.assignee.userId, granted.id); // to himself from the Assign list
    assert.equal((await ok(take, { c: chats[3] }, granted.token)).claimConversation.assignee.userId, granted.id); // already his: no-op
    assert.equal(await errorCode(take, { c: chats[1] }, granted.token), 'ALREADY_ASSIGNED'); // Anil's chat: Assign to Me never takes it
    assert.equal((await ok(TO_MEMBER, { c: chats[2], m: granted.id }, granted.token)).assignConversation.assignee.userId, granted.id); // but the Assign list reassigns it
    assert.equal((await ok(TO_MEMBER, { c: chats[2], m: agent.id }, granted.token)).assignConversation.assignee.userId, agent.id); // and back to Anil
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
  const TO_MEMBER = `mutation($c: ID!, $m: ID) { assignConversation(conversationId: $c, memberId: $m, reason: "e2e") { id assignee { id name userId user { id name email role } } } }`;
  const UNASSIGN = `mutation($c: ID!) { assignConversation(conversationId: $c, assigneeId: null, reason: "e2e") { id assignee { id } } }`;
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
    let r = (await ok(TO_MEMBER, { c: conv, m: agent.id }, sup.token)).assignConversation.assignee; // a supervisor assigns
    assert.equal(r.userId, agent.id);
    r = (await ok(TO_MEMBER, { c: conv, m: agent.id }, admin.token)).assignConversation.assignee; // already his: no-op
    assert.deepEqual(r.user, { id: agent.id, name: 'Arjun', email: agent.email, role: 'agent' });
    r = (await ok(TO_MEMBER, { c: conv, m: sup.id }, admin.token)).assignConversation.assignee;
    assert.deepEqual([r.userId, r.user.role], [sup.id, 'supervisor']);
    assert.equal((await ok(UNASSIGN, { c: conv }, admin.token)).assignConversation.assignee, null); // "Unassigned"
    const history = (await ok(`query($c: ID!) { conversationActivity(conversationId: $c) { type } }`, { c: conv }, owner.token)).conversationActivity.map((a: any) => a.type);
    assert.deepEqual(history, ['assigned', 'reassigned', 'unassigned']);
  });

  test('Unassigned for every role: agents release their own chat or anyone else\'s, supervisors too', async () => {
    await ok(TO_MEMBER, { c: conv, m: other.id }, admin.token); // Bela's
    assert.equal((await ok(UNASSIGN, { c: conv }, agent.token)).assignConversation.assignee, null); // Arjun releases Bela's
    await ok(TO_MEMBER, { c: conv, m: other.id }, other.token); // Bela takes it back from the Assign list
    assert.equal((await ok(UNASSIGN, { c: conv }, other.token)).assignConversation.assignee, null); // and releases her own
    await ok(TO_MEMBER, { c: conv, m: other.id }, sup.token); // a supervisor assigns
    assert.equal((await ok(UNASSIGN, { c: conv }, sup.token)).assignConversation.assignee, null); // and releases
    assert.equal((await ok(UNASSIGN, { c: conv }, other.token)).assignConversation.assignee, null); // a no-op is fine
  });
});

describe('Assign dropdown uses existing records: assigning a person uses their membership, never creates rows', () => {
  const TO_MEMBER = `mutation($c: ID!, $m: ID) { assignConversation(conversationId: $c, memberId: $m, reason: "e2e") { assignee { id name color userId } } }`;
  const UNASSIGN = `mutation($c: ID!) { assignConversation(conversationId: $c, assigneeId: null, reason: "e2e") { assignee { id } } }`;
  let ws: { token: string; workspaceId: string };
  let sup: { id: string; token: string };
  let agent: { id: string; token: string };
  let fresh: { id: string; token: string };
  const chats: string[] = [];
  const rowCounts = async () => ({ users: await prisma.user.count(), members: await prisma.member.count({ where: { workspaceId: ws.workspaceId } }) });
  const memberId = async (userId: string) => (await prisma.member.findUniqueOrThrow({ where: { userId_workspaceId: { userId, workspaceId: ws.workspaceId } } })).id;

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

  test('every chat assigned to a person points at the same membership, in their role colour; no rows are created', async () => {
    const before = await rowCounts();
    const mAkash = await memberId(agent.id);
    assert.equal((await ok(TO_MEMBER, { c: chats[0], m: agent.id }, sup.token)).assignConversation.assignee.id, mAkash); // supervisors assign too
    for (const c of chats) {
      const a = (await ok(TO_MEMBER, { c, m: agent.id }, ws.token)).assignConversation.assignee;
      assert.deepEqual([a.id, a.name, a.color, a.userId], [mAkash, 'Akash', '#047857', agent.id]);
    }
    assert.deepEqual(await rowCounts(), before); // no new users or memberships
    assert.equal((await ok(`{ conversations(assignee: "me") { nodes { id } } }`, undefined, agent.token)).conversations.nodes.length, 3); // My Chats
  });

  test('unassigning and reassigning reuse the membership; agents release their own chats', async () => {
    const before = await rowCounts();
    const mFarah = await memberId(fresh.id);
    const first = (await ok(TO_MEMBER, { c: chats[0], m: fresh.id }, ws.token)).assignConversation.assignee;
    const second = (await ok(TO_MEMBER, { c: chats[1], m: fresh.id }, ws.token)).assignConversation.assignee;
    assert.deepEqual([first.id, second.id], [mFarah, mFarah]);
    await ok(UNASSIGN, { c: chats[0] }, ws.token);
    await ok(UNASSIGN, { c: chats[1] }, fresh.token); // agents release their own
    await ok(UNASSIGN, { c: chats[1] }, ws.token); // already unassigned: no-op
    assert.deepEqual((await ok(`{ conversations(assignee: "me") { nodes { id } } }`, undefined, fresh.token)).conversations.nodes, []);
    assert.equal((await ok(TO_MEMBER, { c: chats[0], m: fresh.id }, ws.token)).assignConversation.assignee.id, mFarah);
    assert.deepEqual(await rowCounts(), before);
  });
});

describe('My Chats regressions: login + workspace scoping, never by name or email, assign/reassign/unassign sync', () => {
  const MINE = `{ conversations(assignee: "me") { nodes { id unread contact { name } assignee { userId } } } }`;
  const TO_MEMBER = `mutation($c: ID!, $m: ID) { assignConversation(conversationId: $c, memberId: $m, reason: "e2e") { id } }`;
  const UNASSIGN = `mutation($c: ID!) { assignConversation(conversationId: $c, assigneeId: null, reason: "e2e") { id } }`;
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
    // One membership per workspace, each with Mia's real userId
    const links = await prisma.member.findMany({ where: { userId: mia.id }, select: { workspaceId: true } });
    assert.deepEqual(links.map((l) => l.workspaceId).sort(), [ws1.workspaceId, ws2.workspaceId].sort());
  });

  test('assign -> reassign -> unassign: each step shows in the right My Chats at once, with counts and unread in sync', async () => {
    const counts = async () =>
      Object.fromEntries((await ok(`{ assignees { userId conversationCount } }`, undefined, ws1.token)).assignees.filter((a: any) => [mia.id, leo.id].includes(a.userId)).map((a: any) => [a.userId, a.conversationCount])); // the two people under test
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

describe('New Leads: Assign to Me (claim), no replies before assignment, concurrent claims', () => {
  type U = { id: string; token: string };
  const CLAIM = `mutation($c: ID!) { claimConversation(conversationId: $c) { id assignee { id name userId } } }`;
  const LEADS = `{ conversations(assignee: "unassigned") { nodes { id contact { name } } } }`;
  const MINE = `{ conversations(assignee: "me") { nodes { id } } }`;
  const SEND = `mutation($i: SendTextInput!) { sendTextMessage(input: $i) { id body sentById } }`;
  const TEMPLATE = `mutation($i: SendTemplateInput!) { sendTemplateMessage(input: $i) { id } }`;
  let ws: { token: string; workspaceId: string };
  let owner: U;
  let sup: U;
  let ana: U;
  let ben: U;
  const chat: Record<string, string> = {};
  const leadNames = async (token: string) => (await ok(LEADS, undefined, token)).conversations.nodes.map((c: any) => c.contact.name).sort();
  const roles = async () => (await prisma.member.findMany({ where: { workspaceId: ws.workspaceId }, orderBy: { userId: 'asc' } })).map((m) => `${m.userId}:${m.role}`);

  async function member(name: string, role: string): Promise<U> {
    const email = `e2e-leads-${name.toLowerCase()}-${run}@example.com`;
    const user = await prisma.user.create({
      data: { name, email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role, workspaceId: ws.workspaceId } } },
    });
    created.userIds.push(user.id);
    return { id: user.id, token: (await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } })).login.token };
  }

  before(async () => {
    ws = await newWorkspace('leads');
    owner = { id: (await ok(`{ me { user { id } } }`, undefined, ws.token)).me.user.id, token: ws.token };
    sup = await member('Sona', 'supervisor');
    ana = await member('Ana', 'agent');
    ben = await member('Ben', 'agent');
    // A (fake) connected number so replies are attempted for real once allowed (Meta rejects the fake token)
    await prisma.whatsAppAccount.create({ data: { workspaceId: ws.workspaceId, wabaId: 'w', phoneNumberId: `pn-leads-${run}`, accessToken: 'fake-token-e2e' } });
    for (let n = 1; n <= 8; n++) await ok(SIMULATE, { i: { waId: `9178800000${String(n).padStart(2, '0')}`, name: `Lead ${n}`, body: 'Do you have 205/55 R16?' } }, ws.token);
    for (const c of (await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes) chat[c.contact.name] = c.id;
  });

  test('New Leads lists unassigned chats; an Agent takes one with Assign to Me and keeps their role', async () => {
    assert.equal((await leadNames(ana.token)).length, 8);
    const rolesBefore = await roles();
    const r = (await ok(CLAIM, { c: chat['Lead 1'] }, ana.token)).claimConversation;
    assert.equal(r.assignee.userId, ana.id);
    assert.deepEqual(await roles(), rolesBefore); // nobody's role changed
    assert.ok(!(await leadNames(ben.token)).includes('Lead 1')); // left New Leads for everyone
    assert.deepEqual((await ok(MINE, undefined, ana.token)).conversations.nodes.map((c: any) => c.id), [chat['Lead 1']]); // in Ana's My Chats
    const history = (await ok(`query($c: ID!) { conversationActivity(conversationId: $c) { type actorName } }`, { c: chat['Lead 1'] }, owner.token)).conversationActivity;
    assert.deepEqual(history.map((a: any) => [a.type, a.actorName]), [['assigned', 'Ana']]);
  });

  test('agents cannot reply before assignment (GraphQL text and template, REST); nothing is stored; after Assign to Me it works. Owners, admins and supervisors may reply to an unheld chat', async () => {
    const lead = chat['Lead 2'];
    const before = await prisma.message.count({ where: { conversationId: lead } });
    assert.equal(await errorCode(SEND, { i: { conversationId: lead, body: 'hi' } }, ana.token), 'NOT_ASSIGNED');
    assert.equal(await errorCode(TEMPLATE, { i: { conversationId: lead, name: 'hello_world' } }, ana.token), 'NOT_ASSIGNED');
    const rest = await rest_('POST', `/inbox/conversations/${lead}/messages`, ana.token, { type: 'text', body: 'hi' });
    assert.equal(rest.status, 409);
    assert.equal(await prisma.message.count({ where: { conversationId: lead } }), before);
    // Owners/admins and supervisors are not blocked by the lead rule; replying does not take the chat
    assert.notEqual((await gql(SEND, { i: { conversationId: lead, body: 'Admin here' } }, owner.token)).errors?.[0]?.extensions?.code, 'NOT_ASSIGNED');
    assert.notEqual((await gql(TEMPLATE, { i: { conversationId: lead, name: 'hello_world' } }, sup.token)).errors?.[0]?.extensions?.code, 'NOT_ASSIGNED');
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: lead } })).assignedToId, null);

    await ok(CLAIM, { c: lead }, ana.token);
    const sent = (await ok(SEND, { i: { conversationId: lead, body: 'Yes, in stock' } }, ana.token)).sendTextMessage;
    assert.deepEqual([sent.body, sent.sentById], ['Yes, in stock', ana.id]);
  });

  test('claiming at the same moment: exactly one person gets each chat, the other is told who has it', async () => {
    for (const [name, a, b] of [['Lead 3', ana, ben], ['Lead 4', ben, ana], ['Lead 5', sup, ana], ['Lead 6', ana, sup]] as const) {
      const [r1, r2] = await Promise.all([gql(CLAIM, { c: chat[name] }, a.token), gql(CLAIM, { c: chat[name] }, b.token)]);
      const wins = [r1, r2].filter((r) => !r.errors);
      const losses = [r1, r2].filter((r) => r.errors);
      assert.equal(wins.length, 1, `${name}: ${JSON.stringify([r1, r2])}`);
      assert.equal(losses[0].errors![0].extensions?.code, 'ALREADY_ASSIGNED');
      assert.match(losses[0].errors![0].message, /already taken by/);
      const winner = wins[0].data.claimConversation.assignee.userId;
      const db = await prisma.conversation.findUniqueOrThrow({ where: { id: chat[name] }, include: { assignedTo: true } });
      assert.equal(db.assignedTo?.userId, winner); // the database agrees with the winner
      const history = await prisma.activityEvent.findMany({ where: { conversationId: chat[name], type: { in: ['assigned', 'reassigned'] } } });
      assert.equal(history.length, 1); // one assignment, never overwritten
    }
  });

  test('claim rules: already yours is fine; someone else\'s is refused for every role; other workspaces and signed-out users get nothing', async () => {
    assert.equal((await ok(CLAIM, { c: chat['Lead 1'] }, ana.token)).claimConversation.assignee.userId, ana.id); // already Ana's
    for (const u of [ben, sup, owner]) assert.equal(await errorCode(CLAIM, { c: chat['Lead 1'] }, u.token), 'ALREADY_ASSIGNED');
    assert.equal(await errorCode(CLAIM, { c: chat['Lead 7'] }, B.token), 'NOT_FOUND');
    assert.equal((await gql(CLAIM, { c: chat['Lead 7'] })).errors?.[0].extensions?.code, 'UNAUTHENTICATED');
    // The owner (an Admin) can take a lead too
    assert.equal((await ok(CLAIM, { c: chat['Lead 7'] }, owner.token)).claimConversation.assignee.userId, owner.id);
  });

  test('Socket.IO: nobody "types" in an unassigned chat; once taken, typing and the assignment reach everyone live', async () => {
    const listen = async (token: string) => {
      const socket = connectSocket(API, { auth: { token }, transports: ['websocket'], forceNew: true });
      const events: { event: string; data: any }[] = [];
      socket.onAny((event, data) => events.push({ event, data }));
      await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
      return { socket, events };
    };
    const a = await listen(ana.token);
    const b = await listen(ben.token);
    const lead = chat['Lead 8'];
    a.socket.emit('typing', { conversationId: lead, typing: true });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(b.events.filter((e) => e.event === 'typing').length, 0); // dropped: not assigned yet
    await ok(CLAIM, { c: lead }, ana.token);
    a.socket.emit('typing', { conversationId: lead, typing: true });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(b.events.filter((e) => e.event === 'typing').map((e) => [e.data.conversationId, e.data.typing]), [[lead, true]]);
    assert.deepEqual(b.events.filter((e) => e.event === 'conversation:assigned').map((e) => [e.data.conversationId, e.data.assignee.userId]), [[lead, ana.id]]);
    a.socket.disconnect();
    b.socket.disconnect();
  });
});

const rest_ = rest;

describe('assignment permissions: every role assigns, reassigns and unassigns; Assign to Me only takes unassigned chats', () => {
  type U = { id: string; token: string };
  const ME = `{ me { role canManageAssignments } }`;
  const TO_MEMBER = `mutation($c: ID!, $m: ID) { assignConversation(conversationId: $c, memberId: $m, reason: "e2e") { assignee { userId } } }`;
  const TO_ASSIGNEE = `mutation($c: ID!, $a: ID) { assignConversation(conversationId: $c, assigneeId: $a, reason: "e2e") { assignee { id userId } } }`;
  const TAKE = `mutation($c: ID!) { claimConversation(conversationId: $c) { assignee { userId } } }`;
  const ROLE = `mutation($u: ID!, $r: String!) { updateMemberRole(userId: $u, role: $r) { role } }`;
  let ws: { token: string; workspaceId: string };
  let admin: U;
  let sup: U;
  let agent: U;
  let agent2: U;
  const chat: Record<string, string> = {};
  const holder = async (c: string) =>
    (await prisma.conversation.findUniqueOrThrow({ where: { id: c }, include: { assignedTo: true } })).assignedTo?.userId ?? null;
  // What the Inbox, New Leads and My Chats pages read to show or hide the Assign checkboxes
  const canManage = async (token: string) => (await ok(ME, undefined, token)).me.canManageAssignments as boolean;

  async function member(name: string, role: string): Promise<U> {
    const email = `e2e-perm-${name.toLowerCase()}-${run}@example.com`;
    const user = await prisma.user.create({
      data: { name, email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role, workspaceId: ws.workspaceId } } },
    });
    created.userIds.push(user.id);
    const { login } = await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } });
    return { id: user.id, token: login.token };
  }

  before(async () => {
    ws = await newWorkspace('perm');
    admin = await member('Adil', 'admin');
    sup = await member('Suha', 'supervisor');
    agent = await member('Ajay', 'agent');
    agent2 = await member('Aru', 'agent');
    for (const n of [1, 2, 3, 4, 5, 6, 7])
      await ok(SIMULATE, { i: { waId: `91783000000${n}`, name: `Perm ${n}`, body: 'hi' } }, ws.token);
    for (const c of (await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes) chat[c.contact.name] = c.id;
  });

  test('checkbox visibility flag: true for every role (owner, admin, supervisor and agent)', async () => {
    assert.deepEqual((await ok(ME, undefined, ws.token)).me, { role: 'owner', canManageAssignments: true });
    assert.deepEqual((await ok(ME, undefined, admin.token)).me, { role: 'admin', canManageAssignments: true });
    assert.deepEqual((await ok(ME, undefined, sup.token)).me, { role: 'supervisor', canManageAssignments: true });
    assert.deepEqual((await ok(ME, undefined, agent.token)).me, { role: 'agent', canManageAssignments: true });
    // There is no grant to manage: setAssignmentPermission is gone from the schema
    assert.ok(!(await ok(`{ __schema { mutationType { fields { name } } } }`, undefined, ws.token)).__schema.mutationType.fields.some((f: any) => f.name === 'setAssignmentPermission'));
    assert.equal(await errorCode(`mutation($u: ID!) { setAssignmentPermission(userId: $u, canManageAssignments: true) { userId } }`, { u: sup.id }, admin.token), 'GRAPHQL_VALIDATION_FAILED');
  });

  test('admins (and the owner) assign, reassign and unassign to any member', async () => {
    assert.equal((await ok(TO_MEMBER, { c: chat['Perm 1'], m: agent.id }, admin.token)).assignConversation.assignee.userId, agent.id);
    assert.equal((await ok(TO_MEMBER, { c: chat['Perm 1'], m: sup.id }, admin.token)).assignConversation.assignee.userId, sup.id);
    assert.equal((await ok(TO_MEMBER, { c: chat['Perm 1'], m: admin.id }, ws.token)).assignConversation.assignee.userId, admin.id);
    assert.equal((await ok(TO_ASSIGNEE, { c: chat['Perm 1'], a: null }, ws.token)).assignConversation.assignee, null);
  });

  test('supervisors assign, reassign and unassign by every route; Assign to Me still only takes an unassigned chat', async () => {
    assert.equal((await ok(TO_MEMBER, { c: chat['Perm 2'], m: agent2.id }, sup.token)).assignConversation.assignee.userId, agent2.id); // to someone else
    assert.equal((await ok(TO_MEMBER, { c: chat['Perm 2'], m: sup.id }, sup.token)).assignConversation.assignee.userId, sup.id); // reassign to self
    assert.equal((await ok(TO_ASSIGNEE, { c: chat['Perm 2'], a: null }, sup.token)).assignConversation.assignee, null); // unassign
    const ajay = (await prisma.member.findUniqueOrThrow({ where: { userId_workspaceId: { userId: agent.id, workspaceId: ws.workspaceId } } })).id; // his membership
    assert.equal((await ok(TO_ASSIGNEE, { c: chat['Perm 3'], a: ajay }, sup.token)).assignConversation.assignee.userId, agent.id); // by member id
    assert.equal(await canManage(sup.token), true);
    assert.equal(await holder(chat['Perm 2']), null);
    assert.equal(await holder(chat['Perm 3']), agent.id);
    // Assign to Me: takes an unassigned chat, never someone else's
    assert.equal(await errorCode(TAKE, { c: chat['Perm 3'] }, sup.token), 'ALREADY_ASSIGNED');
    assert.equal((await ok(TAKE, { c: chat['Perm 2'] }, sup.token)).claimConversation.assignee.userId, sup.id);
    assert.equal((await ok(TO_ASSIGNEE, { c: chat['Perm 2'], a: null }, sup.token)).assignConversation.assignee, null); // released again
    assert.equal((await ok(TO_ASSIGNEE, { c: chat['Perm 3'], a: null }, sup.token)).assignConversation.assignee, null); // Ajay's too
  });

  test('role changes keep the flag on: the live member:permissions event and the next request both say true', async () => {
    const live = connectSocket(API, { auth: { token: sup.token }, transports: ['websocket'], forceNew: true });
    const events: { event: string; data: any }[] = [];
    live.onAny((event, data) => events.push({ event, data }));
    try {
      await new Promise<void>((resolve, reject) => {
        live.on('connect', () => resolve());
        live.on('connect_error', reject);
      });
      await ok(ROLE, { u: sup.id, r: 'admin' }, ws.token);
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(events.some((e) => e.event === 'member:permissions' && e.data.userId === sup.id && e.data.role === 'admin' && e.data.canManageAssignments === true));
    } finally {
      live.disconnect();
    }
    assert.equal(await canManage(sup.token), true);
    assert.equal((await ok(TO_MEMBER, { c: chat['Perm 4'], m: agent.id }, sup.token)).assignConversation.assignee.userId, agent.id);
    await ok(ROLE, { u: sup.id, r: 'supervisor' }, ws.token); // demoted: still assigns
    assert.equal(await canManage(sup.token), true);
    assert.equal((await ok(TO_ASSIGNEE, { c: chat['Perm 4'], a: null }, sup.token)).assignConversation.assignee, null);
    assert.equal(await holder(chat['Perm 4']), null);
  });

  test('agents: assign to anyone, to themselves, hand over and release; Assign to Me only takes an unassigned chat', async () => {
    assert.equal(await canManage(agent.token), true);
    assert.equal((await ok(TO_MEMBER, { c: chat['Perm 5'], m: agent2.id }, agent.token)).assignConversation.assignee.userId, agent2.id); // to someone else
    assert.equal((await ok(TO_MEMBER, { c: chat['Perm 5'], m: agent.id }, agent.token)).assignConversation.assignee.userId, agent.id); // to self from the Assign list
    assert.equal((await ok(TO_ASSIGNEE, { c: chat['Perm 5'], a: null }, agent.token)).assignConversation.assignee, null); // release
    const ajay = (await prisma.member.findUniqueOrThrow({ where: { userId_workspaceId: { userId: agent.id, workspaceId: ws.workspaceId } } })).id; // his membership
    assert.equal((await ok(TO_ASSIGNEE, { c: chat['Perm 5'], a: ajay }, agent.token)).assignConversation.assignee.userId, agent.id); // by member id
    assert.equal((await ok(TO_ASSIGNEE, { c: chat['Perm 5'], a: null }, agent2.token)).assignConversation.assignee, null); // another agent releases it
    assert.equal(await holder(chat['Perm 5']), null);
    assert.equal((await ok(TAKE, { c: chat['Perm 5'] }, agent.token)).claimConversation.assignee.userId, agent.id); // Assign to Me on New Leads
    assert.equal(await canManage(agent.token), true); // New Leads -> My Chats: checkboxes stay
    assert.equal((await ok(TAKE, { c: chat['Perm 5'] }, agent.token)).claimConversation.assignee.userId, agent.id); // again: no-op
    assert.equal(await errorCode(TAKE, { c: chat['Perm 5'] }, agent2.token), 'ALREADY_ASSIGNED'); // Assign to Me never takes someone else's
    assert.equal((await ok(TO_MEMBER, { c: chat['Perm 5'], m: agent2.id }, agent.token)).assignConversation.assignee.userId, agent2.id); // hand over
    // A label grant changes nothing here
    await ok(`mutation($u: ID!) { setLabelPermission(userId: $u, canManageLabels: true) { userId } }`, { u: agent.id }, admin.token);
    assert.equal((await ok(TO_ASSIGNEE, { c: chat['Perm 5'], a: null }, agent.token)).assignConversation.assignee, null);
    assert.equal(await holder(chat['Perm 5']), null);
  });

  test('unauthorized requests: signed out, other workspaces and removed members change nothing', async () => {
    const c = chat['Perm 6'];
    assert.equal(await errorCode(TAKE, { c }), 'UNAUTHENTICATED');
    assert.equal(await errorCode(TO_MEMBER, { c, m: agent.id }), 'UNAUTHENTICATED');
    assert.equal(await errorCode(TAKE, { c }, 'not-a-token'), 'UNAUTHENTICATED');
    assert.equal(await errorCode(TAKE, { c }, B.token), 'NOT_FOUND'); // another workspace's chat
    assert.equal(await errorCode(TO_MEMBER, { c, m: agent.id }, B.token), 'NOT_FOUND');
    const bUser = (await ok(`{ me { user { id } } }`, undefined, B.token)).me.user.id;
    assert.equal(await errorCode(TO_MEMBER, { c, m: bUser }, admin.token), 'NOT_FOUND'); // not a member here
    // Removed from the workspace: their old token stops working at once
    const gone = await member('Gita', 'agent');
    await ok(`mutation($u: ID!) { removeMember(userId: $u) }`, { u: gone.id }, admin.token);
    assert.equal(await errorCode(TAKE, { c }, gone.token), 'UNAUTHENTICATED');
    assert.equal(await holder(c), null);
  });

  test('concurrent assignments never double-assign: one claim wins; an admin racing claims stays consistent', async () => {
    const c = chat['Perm 6'];
    const racers = [agent, agent2, sup];
    const results = await Promise.all(racers.map((u) => gql(TAKE, { c }, u.token)));
    const winners = results.filter((r) => !r.errors);
    assert.equal(winners.length, 1, JSON.stringify(results.map((r) => r.errors?.[0].extensions?.code ?? 'ok')));
    for (const r of results.filter((r) => r.errors)) assert.ok(['ALREADY_ASSIGNED', 'ASSIGN_CONFLICT'].includes(r.errors[0].extensions?.code));
    const first = await holder(c);
    assert.equal(first, winners[0].data.claimConversation.assignee.userId);
    const events = await prisma.activityEvent.findMany({ where: { conversationId: c, type: { in: ['assigned', 'reassigned'] } } });
    assert.equal(events.length, 1); // one history entry for one change

    // An admin unassigns while agents race to claim it back: each change is recorded once, the end state is consistent
    const outcome = await Promise.all([
      gql(TO_ASSIGNEE, { c, a: null }, admin.token),
      gql(TAKE, { c }, agent.token),
      gql(TAKE, { c }, agent2.token),
    ]);
    for (const r of outcome) assert.ok(!r.errors || ['ALREADY_ASSIGNED', 'ASSIGN_CONFLICT'].includes(r.errors[0].extensions?.code), JSON.stringify(r.errors));
    const claimsWon = outcome.slice(1).filter((r) => !r.errors).length;
    assert.ok(claimsWon <= 1, 'two agents must never both win the same chat');
    const final = await holder(c);
    const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: c } });
    const assignees = await prisma.member.findMany({ where: { workspaceId: ws.workspaceId } });
    assert.ok(conv.assignedToId === null || assignees.some((a) => a.id === conv.assignedToId));
    assert.ok(final === null || [agent.id, agent2.id, first].includes(final));

    // Two admins assigning the same chat at once: it ends with one of them, every step in history, nobody else
    const admins = [ws.token, admin.token, ws.token, admin.token];
    const targets = [agent.id, agent2.id, sup.id, agent.id];
    const r2 = await Promise.all(targets.map((m, i) => gql(TO_MEMBER, { c: chat['Perm 7'], m }, admins[i])));
    for (const r of r2) assert.ok(!r.errors || r.errors[0].extensions?.code === 'ASSIGN_CONFLICT', JSON.stringify(r.errors));
    assert.ok([agent.id, agent2.id, sup.id].includes((await holder(chat['Perm 7'])) as string));
  });
});

describe('admin user management: create with password, edit, roles, deactivate; all enforced on the server', () => {
  type U = { id: string; token: string; email: string };
  const INVITE = `mutation($i: InviteMemberInput!) { inviteMember(input: $i) { invited emailSent created member { userId name email role status active } } }`;
  const LOGIN = `mutation($i: LoginInput!) { login(input: $i) { token user { id } workspace { id } } }`;
  const UPDATE = `mutation($u: ID!, $i: UpdateMemberInput!) { updateMember(userId: $u, input: $i) { userId name status active } }`;
  const ACTIVE = `mutation($u: ID!, $a: Boolean!) { setMemberActive(userId: $u, active: $a) { userId status active } }`;
  const SET_ROLE = `mutation($u: ID!, $r: String!) { updateMemberRole(userId: $u, role: $r) { userId role } }`;
  const TEAM = `{ members { userId name email role status active } }`;
  const PEOPLE = `{ workspaceMembers { id name } }`;
  const TO_MEMBER = `mutation($c: ID!, $m: ID) { assignConversation(conversationId: $c, memberId: $m, reason: "e2e") { assignee { userId } } }`;
  const ME = `{ me { user { id } role } }`;
  let ws: { token: string; workspaceId: string };
  let ownerId = '';
  let admin: U;
  let sup: U;
  let agent: U;
  let conv = '';

  async function member(name: string, role: string): Promise<U> {
    const email = `e2e-um-${name.toLowerCase()}-${run}@example.com`;
    const user = await prisma.user.create({
      data: { name, email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role, workspaceId: ws.workspaceId } } },
    });
    created.userIds.push(user.id);
    const { login } = await ok(LOGIN, { i: { email, password: 'password123' } });
    return { id: user.id, token: login.token, email };
  }
  function connect(token: string) {
    const socket = connectSocket(API, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
    const ready = new Promise<boolean>((resolve) => {
      socket.on('connect', () => resolve(true));
      socket.on('connect_error', () => resolve(false));
    });
    return { socket, ready };
  }

  before(async () => {
    ws = await newWorkspace('usermgmt');
    ownerId = (await ok(ME, undefined, ws.token)).me.user.id;
    admin = await member('Adil', 'admin');
    sup = await member('Suha', 'supervisor');
    agent = await member('Ajay', 'agent');
    await ok(SIMULATE, { i: { waId: '917870000001', name: 'UM chat', body: 'hi' } }, ws.token);
    conv = (await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes[0].id;
  });

  test('admin creates a user with an initial password: stored as a hash, never returned, signs in at once with their own id', async () => {
    const email = `e2e-um-new-${run}@example.com`;
    const r = (await ok(INVITE, { i: { name: 'Nia', email, role: 'agent', password: 'Secret123' } }, admin.token)).inviteMember;
    created.userIds.push(r.member.userId);
    assert.deepEqual([r.created, r.invited, r.member.role, r.member.status, r.member.active], [true, false, 'agent', 'active', true]);
    assert.equal(r.emailSent, true); // the login link (and the temporary password) was emailed
    const u = await prisma.user.findUniqueOrThrow({ where: { id: r.member.userId } });
    assert.notEqual(u.passwordHash, 'Secret123');
    assert.ok(await bcrypt.compare('Secret123', u.passwordHash));
    assert.equal(await prisma.passwordResetToken.count({ where: { userId: r.member.userId } }), 0); // no invite link needed
    assert.equal(await errorCode(`{ members { password } }`, undefined, admin.token), 'GRAPHQL_VALIDATION_FAILED'); // no such field, ever
    const { login } = await ok(LOGIN, { i: { email, password: 'Secret123' } });
    assert.deepEqual([login.user.id, login.workspace.id], [r.member.userId, ws.workspaceId]); // own id, own credentials
    assert.equal(await errorCode(LOGIN, { i: { email, password: 'Secret124' } }), 'INVALID_CREDENTIALS');
    assert.equal(await errorCode(LOGIN, { i: { email: admin.email, password: 'Secret123' } }), 'INVALID_CREDENTIALS'); // not someone else's
    const listed = (await ok(TEAM, undefined, admin.token)).members.find((m: any) => m.userId === r.member.userId);
    assert.deepEqual(listed, { userId: r.member.userId, name: 'Nia', email, role: 'agent', status: 'active', active: true });
    assert.ok((await ok(PEOPLE, undefined, agent.token)).workspaceMembers.some((m: any) => m.id === r.member.userId)); // assignable
  });

  test('password rules are enforced on the server and a refused request creates nothing; existing accounts keep their own password', async () => {
    const email = `e2e-um-bad-${run}@example.com`;
    for (const password of ['short1', 'onlyletters', '12345678', 'a1'.repeat(37), ''])
      assert.equal(await errorCode(INVITE, { i: { name: 'Bad', email, role: 'agent', password } }, admin.token), 'BAD_USER_INPUT', password);
    assert.equal(await prisma.user.count({ where: { email } }), 0);
    const bUser = await prisma.user.findFirstOrThrow({ where: { members: { some: { workspaceId: B.workspaceId, role: 'owner' } } } });
    assert.equal(await errorCode(INVITE, { i: { name: 'x', email: bUser.email, role: 'agent', password: 'Secret123' } }, admin.token), 'ACCOUNT_EXISTS');
    assert.equal(await prisma.member.count({ where: { userId: bUser.id, workspaceId: ws.workspaceId } }), 0); // not added either
    assert.ok(await bcrypt.compare('password123', (await prisma.user.findUniqueOrThrow({ where: { id: bUser.id } })).passwordHash)); // untouched
    // Without a password the invite flow is unchanged
    const r = (await ok(INVITE, { i: { name: 'Ivy', email: `e2e-um-ivy-${run}@example.com`, role: 'agent' } }, admin.token)).inviteMember;
    created.userIds.push(r.member.userId);
    assert.deepEqual([r.created, r.invited, r.member.status], [true, true, 'invited']);
    // Sign-up and reset use the same rule
    assert.equal(await errorCode(`mutation($i: RegisterInput!) { register(input: $i) { token } }`, { i: { name: 'W', email: `e2e-um-weak-${run}@example.com`, password: 'onlyletters', workspaceName: 'w' } }), 'BAD_USER_INPUT');
  });

  test('only admins create users, edit them, change roles or deactivate; nobody can escalate their own role', async () => {
    for (const [who, t] of [['supervisor', sup.token], ['agent', agent.token]] as const) {
      assert.equal(await errorCode(INVITE, { i: { name: 'X', email: `e2e-um-x-${who}-${run}@example.com`, role: 'admin', password: 'Secret123' } }, t), 'FORBIDDEN');
      assert.equal(await errorCode(UPDATE, { u: agent.id, i: { name: 'Hacked' } }, t), 'FORBIDDEN');
      assert.equal(await errorCode(UPDATE, { u: admin.id, i: { password: 'Secret123' } }, t), 'FORBIDDEN');
      assert.equal(await errorCode(ACTIVE, { u: admin.id, a: false }, t), 'FORBIDDEN');
      assert.equal(await errorCode(SET_ROLE, { u: who === 'agent' ? agent.id : sup.id, r: 'admin' }, t), 'FORBIDDEN'); // self-promotion
      assert.equal(await errorCode(SET_ROLE, { u: agent.id, r: 'admin' }, t), 'FORBIDDEN');
    }
    assert.equal(await errorCode(UPDATE, { u: agent.id, i: { name: 'Nope' } }), 'UNAUTHENTICATED');
    assert.equal(await errorCode(UPDATE, { u: agent.id, i: { name: 'Nope' } }, B.token), 'NOT_FOUND'); // another workspace's admin
    assert.equal(await errorCode(ACTIVE, { u: agent.id, a: false }, B.token), 'NOT_FOUND');
    assert.deepEqual([(await ok(ME, undefined, agent.token)).me.role, (await ok(ME, undefined, sup.token)).me.role], ['agent', 'supervisor']);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: agent.id } })).name, 'Ajay');
    // Admins promote and demote (never the owner or themselves), and it applies on the next request
    assert.equal((await ok(SET_ROLE, { u: agent.id, r: 'supervisor' }, admin.token)).updateMemberRole.role, 'supervisor');
    assert.equal((await ok(ME, undefined, agent.token)).me.role, 'supervisor');
    await ok(SET_ROLE, { u: agent.id, r: 'agent' }, admin.token);
    assert.equal(await errorCode(SET_ROLE, { u: ownerId, r: 'agent' }, admin.token), 'OWNER_PROTECTED');
    assert.equal(await errorCode(SET_ROLE, { u: admin.id, r: 'agent' }, admin.token), 'CANNOT_CHANGE_SELF');
  });

  test('editing: a new name shows everywhere; a new password signs them out everywhere and the old one stops working', async () => {
    assert.equal((await ok(UPDATE, { u: agent.id, i: { name: 'Ajay K' } }, admin.token)).updateMember.name, 'Ajay K');
    assert.ok((await ok(PEOPLE, undefined, sup.token)).workspaceMembers.some((m: any) => m.id === agent.id && m.name === 'Ajay K'));
    const live = connect(agent.token);
    assert.equal(await live.ready, true);
    const closed = new Promise<boolean>((resolve) => live.socket.on('disconnect', () => resolve(true)));
    await ok(UPDATE, { u: agent.id, i: { password: 'NewPass123' } }, admin.token);
    assert.equal(await closed, true);
    assert.equal(await errorCode(ME, undefined, agent.token), 'UNAUTHENTICATED'); // old session
    assert.equal(await errorCode(LOGIN, { i: { email: agent.email, password: 'password123' } }), 'INVALID_CREDENTIALS');
    agent.token = (await ok(LOGIN, { i: { email: agent.email, password: 'NewPass123' } })).login.token;
    assert.equal((await ok(ME, undefined, agent.token)).me.user.id, agent.id);
    // Rules: not the owner's account, not your own password, not a weak one
    assert.equal(await errorCode(UPDATE, { u: ownerId, i: { password: 'NewPass123' } }, admin.token), 'OWNER_PROTECTED');
    assert.equal(await errorCode(UPDATE, { u: admin.id, i: { password: 'NewPass123' } }, admin.token), 'CANNOT_CHANGE_SELF');
    assert.equal(await errorCode(UPDATE, { u: agent.id, i: { password: 'weak' } }, admin.token), 'BAD_USER_INPUT');
    assert.equal((await ok(UPDATE, { u: admin.id, i: { name: 'Adil A' } }, admin.token)).updateMember.name, 'Adil A'); // own name is fine
  });

  test('deactivating: sign-in refused, session and Socket.IO cut at once, not assignable; chats and history untouched; reactivation restores all', async () => {
    await ok(TO_MEMBER, { c: conv, m: agent.id }, admin.token); // holds a chat
    const live = connect(agent.token);
    assert.equal(await live.ready, true);
    const closed = new Promise<boolean>((resolve) => live.socket.on('disconnect', () => resolve(true)));

    const r = (await ok(ACTIVE, { u: agent.id, a: false }, admin.token)).setMemberActive;
    assert.deepEqual([r.status, r.active], ['inactive', false]);
    assert.equal(await closed, true);
    assert.equal((await gql(CONVERSATIONS, {}, agent.token)).errors?.[0].extensions?.code, 'UNAUTHENTICATED');
    assert.equal((await rest('GET', '/inbox/conversations', agent.token)).status, 401);
    const again = connect(agent.token);
    assert.equal(await again.ready, false);
    again.socket.disconnect();
    assert.equal(await errorCode(LOGIN, { i: { email: agent.email, password: 'NewPass123' } }), 'ACCOUNT_INACTIVE');
    assert.ok(!(await ok(PEOPLE, undefined, sup.token)).workspaceMembers.some((m: any) => m.id === agent.id)); // out of the Assign list
    assert.equal(await errorCode(TO_MEMBER, { c: conv, m: agent.id }, admin.token), 'NOT_FOUND');
    assert.equal((await ok(TEAM, undefined, admin.token)).members.find((m: any) => m.userId === agent.id).status, 'inactive');
    // Nothing deleted: the chat is still theirs and the history is intact
    const chat = await prisma.conversation.findUniqueOrThrow({ where: { id: conv }, include: { assignedTo: true } });
    assert.equal(chat.assignedTo?.userId, agent.id);
    assert.ok((await prisma.activityEvent.count({ where: { conversationId: conv, type: 'assigned' } })) >= 1);
    assert.ok(await prisma.user.findUnique({ where: { id: agent.id } }));
    // Never the owner or yourself
    assert.equal(await errorCode(ACTIVE, { u: ownerId, a: false }, admin.token), 'OWNER_PROTECTED');
    assert.equal(await errorCode(ACTIVE, { u: admin.id, a: false }, admin.token), 'CANNOT_CHANGE_SELF');
    // Deactivated here only: a workspace where they are still active still lets them in
    await prisma.member.create({ data: { userId: agent.id, workspaceId: B.workspaceId, role: 'agent' } });
    assert.equal((await ok(LOGIN, { i: { email: agent.email, password: 'NewPass123', workspaceId: ws.workspaceId } })).login.workspace.id, B.workspaceId);
    await prisma.member.delete({ where: { userId_workspaceId: { userId: agent.id, workspaceId: B.workspaceId } } });
    assert.equal(await errorCode(LOGIN, { i: { email: agent.email, password: 'NewPass123' } }), 'ACCOUNT_INACTIVE');

    const back = (await ok(ACTIVE, { u: agent.id, a: true }, admin.token)).setMemberActive;
    assert.deepEqual([back.status, back.active], ['active', true]);
    agent.token = (await ok(LOGIN, { i: { email: agent.email, password: 'NewPass123' } })).login.token;
    assert.equal((await ok(ME, undefined, agent.token)).me.user.id, agent.id);
    assert.ok((await ok(PEOPLE, undefined, sup.token)).workspaceMembers.some((m: any) => m.id === agent.id));
    assert.deepEqual((await ok(`{ conversations(assignee: "me") { nodes { id } } }`, undefined, agent.token)).conversations.nodes.map((c: any) => c.id), [conv]);
  });

  test('a workspace always keeps an active admin: the owner is protected, nobody acts on themselves, and the backstop refuses the last one', async () => {
    const activeAdmins = () => prisma.member.count({ where: { workspaceId: ws.workspaceId, active: true, role: { in: ['owner', 'admin'] } } });
    const admin2 = await member('Bela', 'admin');
    // Through the API: other admins can be deactivated while the owner (always active) remains
    assert.equal((await ok(ACTIVE, { u: admin2.id, a: false }, admin.token)).setMemberActive.active, false);
    assert.equal(await errorCode(ME, undefined, admin2.token), 'UNAUTHENTICATED');
    assert.equal(await errorCode(ACTIVE, { u: ownerId, a: false }, admin.token), 'OWNER_PROTECTED');
    assert.equal(await errorCode(ACTIVE, { u: admin.id, a: false }, admin.token), 'CANNOT_CHANGE_SELF');
    assert.equal(await errorCode(ACTIVE, { u: ownerId, a: false }, ws.token), 'CANNOT_CHANGE_SELF'); // not even the owner on themselves
    assert.ok((await activeAdmins()) >= 1);
    await ok(ACTIVE, { u: admin2.id, a: true }, admin.token);

    // Backstop, at the service level: the owner row forced inactive in the database (never possible through the API)
    // and the acting admin's own deactivation racing in. Deactivating, demoting or removing the last active admin is refused.
    await prisma.member.update({ where: { userId_workspaceId: { userId: ownerId, workspaceId: ws.workspaceId } }, data: { active: false } });
    await prisma.member.update({ where: { userId_workspaceId: { userId: admin.id, workspaceId: ws.workspaceId } }, data: { active: false } });
    try {
      const asAdmin = { userId: admin.id, workspaceId: ws.workspaceId };
      await assert.rejects(setMemberActive(asAdmin, admin2.id, false), (e: any) => e.code === 'LAST_ADMIN');
      await assert.rejects(updateMemberRole(asAdmin, admin2.id, 'agent'), (e: any) => e.code === 'LAST_ADMIN');
      assert.equal((await ok(ME, undefined, admin2.token)).me.role, 'admin'); // untouched, still signed in
      assert.equal(await activeAdmins(), 1);
      // Reactivating is always allowed, and then the deactivation goes through
      await setMemberActive(asAdmin, admin2.id, true);
    } finally {
      await prisma.member.updateMany({ where: { workspaceId: ws.workspaceId, userId: { in: [ownerId, admin.id] } }, data: { active: true } });
    }
    assert.equal((await ok(ACTIVE, { u: admin2.id, a: false }, admin.token)).setMemberActive.active, false);
    assert.ok((await activeAdmins()) >= 1);
    // Supervisors and agents can't change anyone's status, including their own or the owner's
    for (const t of [sup.token, agent.token]) {
      assert.equal(await errorCode(ACTIVE, { u: admin2.id, a: true }, t), 'FORBIDDEN');
      assert.equal(await errorCode(ACTIVE, { u: ownerId, a: false }, t), 'FORBIDDEN');
    }
    assert.equal((await ok(TEAM, undefined, admin.token)).members.find((m: any) => m.userId === admin2.id).status, 'inactive');
  });

  test('delete and recreate: a removed user\'s email can be used again (admin form and self sign-up); emails in use elsewhere stay blocked', async () => {
    const REGISTER = `mutation($i: RegisterInput!) { register(input: $i) { token user { id } workspace { id } } }`;
    const REMOVE = `mutation($u: ID!) { removeMember(userId: $u) }`;
    const email = `e2e-um-zed-${run}@example.com`;
    const first = (await ok(INVITE, { i: { name: 'Zed', email, role: 'agent', password: 'First123' } }, admin.token)).inviteMember.member;
    created.userIds.push(first.userId);
    const zed = (await ok(LOGIN, { i: { email, password: 'First123' } })).login.token;
    await ok(SIMULATE, { i: { waId: '917870000002', name: 'Zed lead', body: 'hi' } }, ws.token);
    const lead = (await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes.find((c: any) => c.contact.name === 'Zed lead').id;
    await ok(`mutation($c: ID!) { claimConversation(conversationId: $c) { id } }`, { c: lead }, zed); // leaves history behind
    assert.equal(await errorCode(INVITE, { i: { name: 'Zed again', email, role: 'agent', password: 'Second123' } }, admin.token), 'MEMBER_EXISTS'); // still a member

    // 1. Remove, then re-add the same email with a new name and password from the admin form
    await ok(REMOVE, { u: first.userId }, admin.token);
    const again = (await ok(INVITE, { i: { name: 'Zed Returned', email, role: 'supervisor', password: 'Second123' } }, admin.token)).inviteMember;
    assert.deepEqual([again.created, again.invited, again.member.name, again.member.role, again.member.status], [true, false, 'Zed Returned', 'supervisor', 'active']);
    assert.equal(again.member.userId, first.userId); // same account row, so old history still names them
    assert.equal(await prisma.user.count({ where: { email } }), 1); // no duplicate account
    assert.equal(await errorCode(LOGIN, { i: { email, password: 'First123' } }), 'INVALID_CREDENTIALS'); // the old password is gone
    assert.equal(await errorCode(ME, undefined, zed), 'UNAUTHENTICATED'); // and the old session
    const back = (await ok(LOGIN, { i: { email, password: 'Second123' } })).login;
    assert.deepEqual([back.user.id, back.workspace.id], [first.userId, ws.workspaceId]);
    const history = (await ok(`query($c: ID!) { conversationActivity(conversationId: $c) { type actorName } }`, { c: lead }, admin.token)).conversationActivity;
    assert.ok(history.some((a: any) => a.type === 'assigned' && a.actorName === 'Zed Returned'));

    // 2. Re-add without a password: treated as a brand-new invite (old password useless, invite link sent)
    await ok(REMOVE, { u: first.userId }, admin.token);
    const invited = (await ok(INVITE, { i: { name: 'Zed Invited', email, role: 'agent' } }, admin.token)).inviteMember;
    assert.deepEqual([invited.created, invited.invited, invited.member.status, invited.member.userId], [true, true, 'invited', first.userId]);
    assert.equal(await errorCode(LOGIN, { i: { email, password: 'Second123' } }), 'INVALID_CREDENTIALS');

    // 3. Removed people can also sign up again themselves: through a signup link, or with a workspace of their own
    await ok(REMOVE, { u: first.userId }, admin.token);
    const { token: joinToken } = (await ok(`mutation { createJoinLink { token } }`, undefined, admin.token)).createJoinLink;
    const self = (await ok(REGISTER, { i: { name: 'Zed Self', email, password: 'Third123', joinToken } })).register;
    assert.deepEqual([self.user.id, self.workspace.id], [first.userId, ws.workspaceId]);
    assert.equal((await ok(ME, undefined, self.token)).me.role, 'agent');
    await ok(REMOVE, { u: first.userId }, admin.token);
    const own = (await ok(REGISTER, { i: { name: 'Zed Owner', email, password: 'Fourth123', workspaceName: `zed-own-${run}` } })).register;
    assert.equal(own.user.id, first.userId);
    assert.equal((await ok(ME, undefined, own.token)).me.role, 'owner');
    await prisma.workspace.delete({ where: { id: own.workspace.id } });

    // 4. Still blocked: an email that belongs to an account in another workspace, and a current member here
    const bUser = await prisma.user.findFirstOrThrow({ where: { members: { some: { workspaceId: B.workspaceId, role: 'owner' } } } });
    assert.equal(await errorCode(INVITE, { i: { name: 'x', email: bUser.email, role: 'agent', password: 'Secret123' } }, admin.token), 'ACCOUNT_EXISTS');
    // ...but the same account is added here without a password (the form's "Add with their existing password"): their
    // own name and password stay, they get the chosen role here, and they can switch between both workspaces
    const added = (await ok(INVITE, { i: { name: 'ignored', email: bUser.email, role: 'supervisor' } }, admin.token)).inviteMember;
    assert.deepEqual([added.created, added.invited, added.member.userId, added.member.name, added.member.role, added.member.status], [false, false, bUser.id, bUser.name, 'supervisor', 'active']);
    assert.ok(await bcrypt.compare('password123', (await prisma.user.findUniqueOrThrow({ where: { id: bUser.id } })).passwordHash)); // untouched
    const both = (await ok(LOGIN, { i: { email: bUser.email, password: 'password123', workspaceId: ws.workspaceId } })).login;
    assert.equal(both.workspace.id, ws.workspaceId);
    assert.equal(await errorCode(INVITE, { i: { name: 'x', email: bUser.email, role: 'agent' } }, admin.token), 'MEMBER_EXISTS'); // now a member here
    await prisma.member.delete({ where: { userId_workspaceId: { userId: bUser.id, workspaceId: ws.workspaceId } } });
    assert.equal(await errorCode(REGISTER, { i: { name: 'x', email: bUser.email, password: 'Secret123', joinToken } }), 'EMAIL_TAKEN');
    assert.equal(await errorCode(REGISTER, { i: { name: 'x', email: agent.email, password: 'Secret123', workspaceName: 'x' } }), 'EMAIL_TAKEN');
    assert.ok(await bcrypt.compare('password123', (await prisma.user.findUniqueOrThrow({ where: { id: bUser.id } })).passwordHash)); // untouched
  });

  test('users change their own password (away from the default): current one required, other sessions out, this one continues', async () => {
    const CHANGE = `mutation($c: String!, $n: String!) { changeMyPassword(currentPassword: $c, newPassword: $n) { token user { id } } }`;
    const email = `e2e-um-default-${run}@example.com`;
    const r = (await ok(INVITE, { i: { name: 'Dee', email, role: 'agent', password: 'Tyres@123' } }, admin.token)).inviteMember; // the pre-filled default
    created.userIds.push(r.member.userId);
    const first = (await ok(LOGIN, { i: { email, password: 'Tyres@123' } })).login.token;
    const other = (await ok(LOGIN, { i: { email, password: 'Tyres@123' } })).login.token; // a second device
    const live = connect(other);
    assert.equal(await live.ready, true);
    const closed = new Promise<boolean>((resolve) => live.socket.on('disconnect', () => resolve(true)));

    assert.equal(await errorCode(CHANGE, { c: 'wrong-pass1', n: 'Mine12345' }, first), 'INVALID_CREDENTIALS');
    assert.equal(await errorCode(CHANGE, { c: 'Tyres@123', n: 'weak' }, first), 'BAD_USER_INPUT');
    assert.equal(await errorCode(CHANGE, { c: 'Tyres@123', n: 'Tyres@123' }, first), 'BAD_USER_INPUT'); // must differ
    assert.equal(await errorCode(CHANGE, { c: 'Tyres@123', n: 'Mine12345' }), 'UNAUTHENTICATED');
    const changed = (await ok(CHANGE, { c: 'Tyres@123', n: 'Mine12345' }, first)).changeMyPassword;
    assert.equal(changed.user.id, r.member.userId);
    assert.equal(await closed, true); // the other device's live connection is dropped
    assert.equal(await errorCode(ME, undefined, other), 'UNAUTHENTICATED'); // and its token
    assert.equal(await errorCode(ME, undefined, first), 'UNAUTHENTICATED'); // the old token of this device too...
    assert.equal((await ok(ME, undefined, changed.token)).me.user.id, r.member.userId); // ...but the fresh one works
    assert.equal(await errorCode(LOGIN, { i: { email, password: 'Tyres@123' } }), 'INVALID_CREDENTIALS');
    assert.ok((await ok(LOGIN, { i: { email, password: 'Mine12345' } })).login.token);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: r.member.userId } });
    assert.ok(await bcrypt.compare('Mine12345', u.passwordHash)); // hash only
  });
});

describe('standard audit fields: createdAt/createdBy/updatedAt/updatedBy/deletedAt/deletedBy/status', () => {
  let ws: { token: string; workspaceId: string };
  let ownerId = '';
  let agent: { id: string; token: string };
  const ME = `{ me { user { id } } }`;

  before(async () => {
    ws = await newWorkspace('audit');
    ownerId = (await ok(ME, undefined, ws.token)).me.user.id;
  });

  test('self sign-up: the person is the creator of their account, membership and workspace; status defaults to active', async () => {
    const [user, member, workspace] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: ownerId } }),
      prisma.member.findUniqueOrThrow({ where: { userId_workspaceId: { userId: ownerId, workspaceId: ws.workspaceId } } }),
      prisma.workspace.findUniqueOrThrow({ where: { id: ws.workspaceId } }),
    ]);
    assert.deepEqual([user.createdBy, member.createdBy, workspace.createdBy], [ownerId, ownerId, ownerId]);
    assert.deepEqual([user.status, workspace.status], ['active', 'active']);
    assert.deepEqual([user.deletedAt, user.deletedBy, user.updatedBy, member.updatedBy], [null, null, null, null]);
    assert.ok(user.updatedAt instanceof Date && member.createdAt instanceof Date && workspace.updatedAt instanceof Date);
  });

  test('admin actions record who did them: invite, role change, deactivate, rename; updatedAt moves', async () => {
    const email = `e2e-audit-agent-${run}@example.com`;
    const r = (await ok(`mutation($i: InviteMemberInput!) { inviteMember(input: $i) { member { userId } } }`, { i: { name: 'Audit Agent', email, role: 'agent', password: 'Secret123' } }, ws.token)).inviteMember;
    created.userIds.push(r.member.userId);
    agent = { id: r.member.userId, token: (await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'Secret123' } })).login.token };
    const where = { userId_workspaceId: { userId: agent.id, workspaceId: ws.workspaceId } };
    let member = await prisma.member.findUniqueOrThrow({ where });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: agent.id } });
    assert.deepEqual([user.createdBy, member.createdBy, member.updatedBy], [ownerId, ownerId, null]);
    const before = member.updatedAt;
    await new Promise((res) => setTimeout(res, 20));
    await ok(`mutation($u: ID!, $r: String!) { updateMemberRole(userId: $u, role: $r) { role } }`, { u: agent.id, r: 'supervisor' }, ws.token);
    member = await prisma.member.findUniqueOrThrow({ where });
    assert.equal(member.updatedBy, ownerId);
    assert.ok(member.updatedAt > before);
    await ok(`mutation($u: ID!, $a: Boolean!) { setMemberActive(userId: $u, active: $a) { active } }`, { u: agent.id, a: false }, ws.token);
    member = await prisma.member.findUniqueOrThrow({ where });
    assert.deepEqual([member.active, member.updatedBy], [false, ownerId]);
    await ok(`mutation($u: ID!, $a: Boolean!) { setMemberActive(userId: $u, active: $a) { active } }`, { u: agent.id, a: true }, ws.token);
    await ok(`mutation($u: ID!) { updateMember(userId: $u, input: { name: "Audit Agent 2" }) { name } }`, { u: agent.id }, ws.token);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: agent.id } })).updatedBy, ownerId);
    // Changing your own password records you
    agent.token = (await ok(`mutation { changeMyPassword(currentPassword: "Secret123", newPassword: "Secret1234") { token } }`, undefined, agent.token)).changeMyPassword.token; // the old token is signed out
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: agent.id } })).updatedBy, agent.id);
  });

  test('labels, started chats, close/reopen and the WhatsApp connection record the actor; webhook-created rows stay system (null)', async () => {
    const label = (await ok(`mutation { createLabel(input: { name: "Audit", color: "#123456" }) { id } }`, undefined, ws.token)).createLabel;
    let row = await prisma.label.findUniqueOrThrow({ where: { id: label.id } });
    assert.deepEqual([row.createdBy, row.updatedBy, row.status, row.deletedAt], [ownerId, null, 'active', null]);
    await ok(`mutation($id: ID!) { updateLabel(id: $id, input: { name: "Audit 2" }) { id } }`, { id: label.id }, ws.token);
    row = await prisma.label.findUniqueOrThrow({ where: { id: label.id } });
    assert.equal(row.updatedBy, ownerId);
    // Hard delete behaviour is unchanged
    await ok(`mutation($id: ID!) { deleteLabel(id: $id) }`, { id: label.id }, ws.token);
    assert.equal(await prisma.label.findUnique({ where: { id: label.id } }), null);

    const started = (await ok(`mutation { startConversation(input: { waId: "919000000001", name: "Audit customer" }) { id } }`, undefined, ws.token)).startConversation;
    const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: started.id }, include: { contact: true } });
    assert.deepEqual([conv.createdBy, conv.contact.createdBy, conv.contact.status], [ownerId, ownerId, 'active']);
    assert.ok(conv.createdAt instanceof Date);
    await ok(`mutation($id: ID!) { closeConversation(id: $id) { id } }`, { id: started.id }, ws.token);
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: started.id } })).updatedBy, ownerId);

    await ok(SIMULATE, { i: { waId: '919000000002', name: 'Webhook customer', body: 'hi' } }, ws.token); // arrives like a webhook: no actor
    const incoming = await prisma.conversation.findFirstOrThrow({ where: { workspaceId: ws.workspaceId, contact: { waId: '919000000002' } }, include: { contact: true } });
    assert.deepEqual([incoming.createdBy, incoming.contact.createdBy], [null, null]);

    // Assigning, labelling, reading and messaging a chat, and editing a message, record the person
    const mAgent = (await prisma.member.findUniqueOrThrow({ where: { userId_workspaceId: { userId: agent.id, workspaceId: ws.workspaceId } } })).id;
    const lead = incoming.id;
    await ok(`mutation($c: ID!, $a: ID) { assignConversation(conversationId: $c, assigneeId: $a, reason: "e2e") { id } }`, { c: lead, a: mAgent }, ws.token);
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: lead } })).updatedBy, ownerId);
    const tag = (await ok(`mutation { createLabel(input: { name: "Audit tag", color: "#654321" }) { id } }`, undefined, ws.token)).createLabel;
    await ok(`mutation($c: ID!, $l: ID!) { addConversationLabel(conversationId: $c, labelId: $l) { id } }`, { c: lead, l: tag.id }, agent.token);
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: lead } })).updatedBy, agent.id);
    await ok(`mutation($id: ID!) { markConversationRead(id: $id) { id } }`, { id: lead }, ws.token);
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: lead } })).updatedBy, ownerId);
    const msg = await prisma.message.create({ data: { conversationId: lead, direction: 'out', type: 'text', body: 'audit', status: 'sent', sentById: agent.id } });
    await ok(`mutation($i: EditMessageInput!) { editMessage(input: $i) { id } }`, { i: { messageId: msg.id, body: 'audit 2', version: 0 } }, agent.token);
    assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: msg.id } })).updatedBy, agent.id);
    await ok(`mutation { markNotificationsSeen }`, undefined, agent.token);
    assert.equal((await prisma.member.findUniqueOrThrow({ where: { id: mAgent } })).updatedBy, agent.id);
    // Joining through a signup link: you are the creator of your own membership
    const { token: join } = (await ok(`mutation { createJoinLink { token } }`, undefined, ws.token)).createJoinLink;
    const joiner = (await ok(`mutation($i: RegisterInput!) { register(input: $i) { user { id } } }`, { i: { name: 'Joiner', email: `e2e-audit-joiner-${run}@example.com`, password: 'Secret123', joinToken: join } })).register;
    created.userIds.push(joiner.user.id);
    const jm = await prisma.member.findUniqueOrThrow({ where: { userId_workspaceId: { userId: joiner.user.id, workspaceId: ws.workspaceId } } });
    assert.equal(jm.createdBy, joiner.user.id);

    // Every table carries the columns (a representative check through raw SQL, so nothing is assumed by the client)
    for (const [table, cols] of Object.entries({
      User: ['createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'deletedAt', 'deletedBy', 'status'],
      Workspace: ['createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'deletedAt', 'deletedBy', 'status'],
      Role: ['createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'deletedAt', 'deletedBy', 'active'],
      WhatsAppAccount: ['createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'deletedAt', 'deletedBy', 'status'],
      Contact: ['createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'deletedAt', 'deletedBy', 'status'],
      Conversation: ['createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'deletedAt', 'deletedBy', 'status'],
      Message: ['createdAt', 'sentById', 'updatedAt', 'updatedBy', 'deletedAt', 'deletedById', 'status'],
      Label: ['createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'deletedAt', 'deletedBy', 'status'],
      Shortchat: ['created_at', 'created_by', 'updated_at', 'updated_by', 'deleted_at', 'deleted_by', 'status'],
    })) {
      const have: any[] = await prisma.$queryRawUnsafe(`SHOW COLUMNS FROM \`${table}\``);
      const names = have.map((c) => c.Field);
      for (const col of cols) assert.ok(names.includes(col), `${table}.${col}`);
    }
  });
});

describe('assignment reasons and the admin assignment report', () => {
  type U = { id: string; token: string; name: string };
  const TO_MEMBER = `mutation($c: ID!, $m: ID, $r: String) { assignConversation(conversationId: $c, memberId: $m, reason: $r) { id assignee { id name userId } } }`;
  const TO_ASSIGNEE = `mutation($c: ID!, $a: ID, $r: String) { assignConversation(conversationId: $c, assigneeId: $a, reason: $r) { id assignee { id name } } }`;
  const TAKE = `mutation($c: ID!) { claimConversation(conversationId: $c) { assignee { userId } } }`;
  const REPORT = `query($from: DateTime, $to: DateTime, $c: ID, $first: Int) { assignmentReport(from: $from, to: $to, conversationId: $c, first: $first) {
    id conversationId contactName contactWaId previousAssignee { memberId userId name } newAssignee { memberId userId name } assignedBy { userId name } reason createdAt } }`;
  const REASON_1 = `Speaks Hindi, customer asked for "Riya" (VIP)`;
  const REASON_2 = 'Shift change\nhanding over to the evening team';
  const REASON_3 = 'Back to the pool: wrong product line';
  let ws: { token: string; workspaceId: string };
  let owner: U;
  let admin: U;
  let sup: U;
  let agent: U;
  let agent2: U;
  const chat: Record<string, string> = {};
  const memberId = async (userId: string) =>
    (await prisma.member.findUniqueOrThrow({ where: { userId_workspaceId: { userId, workspaceId: ws.workspaceId } } })).id;
  const rowsFor = (c: string) => prisma.assignmentRecord.findMany({ where: { conversationId: c }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const report = async (token: string, vars: object = {}) => (await ok(REPORT, vars, token)).assignmentReport as any[];

  async function member(name: string, role: string): Promise<U> {
    const email = `e2e-reason-${name.toLowerCase()}-${run}@example.com`;
    const user = await prisma.user.create({
      data: { name, email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role, workspaceId: ws.workspaceId } } },
    });
    created.userIds.push(user.id);
    const { login } = await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } });
    return { id: user.id, token: login.token, name };
  }

  before(async () => {
    ws = await newWorkspace('reason');
    const me = (await ok(`{ me { user { id name } } }`, undefined, ws.token)).me.user;
    owner = { id: me.id, token: ws.token, name: me.name };
    admin = await member('Adira', 'admin');
    sup = await member('Suraj', 'supervisor');
    agent = await member('Asha', 'agent');
    agent2 = await member('Arun', 'agent');
    for (const n of [1, 2, 3, 4, 5])
      await ok(SIMULATE, { i: { waId: `91784000000${n}`, name: `Reason ${n}`, body: 'hi' } }, ws.token);
    for (const c of (await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes) chat[c.contact.name] = c.id;
  });

  test('an assignment with a reason is stored permanently: chat, previous and new assignee, who did it, reason, time', async () => {
    const c = chat['Reason 1'];
    const t0 = Date.now();
    const r = (await ok(TO_MEMBER, { c, m: agent.id, r: `  ${REASON_1}  ` }, admin.token)).assignConversation;
    assert.equal(r.assignee.userId, agent.id);
    const rows = await rowsFor(c);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.workspaceId, ws.workspaceId);
    assert.equal(row.conversationId, c);
    assert.deepEqual([row.previousMemberId, row.previousUserId, row.previousName], [null, null, null]); // was unassigned
    assert.deepEqual([row.newMemberId, row.newUserId, row.newName], [await memberId(agent.id), agent.id, 'Asha']);
    assert.deepEqual([row.assignedById, row.assignedByName], [admin.id, 'Adira']);
    assert.equal(row.reason, REASON_1); // trimmed, otherwise exactly as typed
    assert.ok(row.createdAt.getTime() >= t0 - 1000 && row.createdAt.getTime() <= Date.now() + 1000);
  });

  test('every reassignment and unassignment adds a row; earlier rows and reasons are never changed or removed; no-ops add nothing', async () => {
    const c = chat['Reason 1'];
    const first = (await rowsFor(c))[0];
    await ok(TO_MEMBER, { c, m: agent.id, r: 'same person again' }, admin.token); // no change: nothing recorded
    assert.equal((await rowsFor(c)).length, 1);
    await ok(TO_MEMBER, { c, m: agent2.id, r: REASON_2 }, agent.token); // Asha hands over to Arun
    assert.equal(await errorCode(TO_ASSIGNEE, { c, a: await memberId(sup.id) }, sup.token), 'REASON_REQUIRED'); // a reason is compulsory
    await ok(TO_ASSIGNEE, { c, a: await memberId(sup.id), r: 'Escalated' }, sup.token); // the supervisor takes it
    await ok(TO_ASSIGNEE, { c, a: null, r: REASON_3 }, agent2.token); // Arun releases it with a reason
    const rows = await rowsFor(c);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows[0], first); // untouched
    assert.deepEqual(
      rows.map((r) => [r.previousName, r.newName, r.assignedByName, r.reason]),
      [
        [null, 'Asha', 'Adira', REASON_1],
        ['Asha', 'Arun', 'Asha', REASON_2],
        ['Arun', 'Suraj', 'Suraj', 'Escalated'],
        ['Suraj', null, 'Arun', REASON_3],
      ],
    );
    assert.deepEqual(rows.map((r) => r.previousMemberId), [null, await memberId(agent.id), await memberId(agent2.id), await memberId(sup.id)]);
    assert.deepEqual(rows.map((r) => r.assignedById), [admin.id, agent.id, sup.id, agent2.id]);
    assert.ok(rows.every((r, i) => i === 0 || r.createdAt >= rows[i - 1].createdAt));
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: c } })).assignedToId, null);
  });

  test('the reason is compulsory for assigning and reassigning (blank counts as missing); Assign to Me and unassigning need none', async () => {
    const c = chat['Reason 2'];
    await ok(TAKE, { c }, agent.token); // Assign to Me: recorded without a reason
    await ok(TAKE, { c }, agent.token); // already theirs: nothing more
    assert.equal(await errorCode(TO_MEMBER, { c, m: agent2.id }, agent.token), 'REASON_REQUIRED'); // reassign without a reason
    assert.equal(await errorCode(TO_MEMBER, { c, m: agent2.id, r: '' }, agent.token), 'REASON_REQUIRED');
    assert.equal(await errorCode(TO_MEMBER, { c, m: agent2.id, r: '   \n ' }, agent.token), 'REASON_REQUIRED');
    assert.equal(await errorCode(TO_ASSIGNEE, { c, a: await memberId(agent2.id) }, owner.token), 'REASON_REQUIRED'); // by member id too
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: c } })).assignedToId, await memberId(agent.id)); // unchanged
    await ok(TO_ASSIGNEE, { c, a: null, r: '   \n ' }, agent.token); // unassign: a blank reason is simply none
    assert.equal(await errorCode(TO_MEMBER, { c, m: agent2.id }, owner.token), 'REASON_REQUIRED'); // assigning an unassigned chat needs one too
    await ok(TO_MEMBER, { c, m: agent2.id, r: 'Arun covers 2nd shift' }, owner.token);
    assert.deepEqual(
      (await rowsFor(c)).map((r) => [r.previousName, r.newName, r.assignedByName, r.reason]),
      [
        [null, 'Asha', 'Asha', null],
        ['Asha', null, 'Asha', null],
        [null, 'Arun', owner.name, 'Arun covers 2nd shift'],
      ],
    );
  });

  test('a reason that is too long or not text is refused and nothing changes', async () => {
    const c = chat['Reason 3'];
    assert.equal(await errorCode(TO_MEMBER, { c, m: agent.id, r: 'x'.repeat(501) }, admin.token), 'BAD_USER_INPUT');
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: c } })).assignedToId, null);
    assert.equal((await rowsFor(c)).length, 0);
    await ok(TO_MEMBER, { c, m: agent.id, r: 'x'.repeat(500) }, admin.token); // the maximum is fine
    assert.equal((await rowsFor(c))[0].reason?.length, 500);
  });

  test('the reason is never visible in the chat: conversations, messages, activity timeline, notifications, socket events, schema', async () => {
    const c = chat['Reason 1'];
    const live = connectSocket(API, { auth: { token: admin.token }, transports: ['websocket'], forceNew: true });
    const events: { event: string; data: any }[] = [];
    live.onAny((event, data) => events.push({ event, data }));
    await new Promise<void>((resolve, reject) => {
      live.on('connect', () => resolve());
      live.on('connect_error', reject);
    });
    const SECRET = 'socket-only-secret-reason';
    try {
      await ok(TO_MEMBER, { c, m: agent.id, r: SECRET }, sup.token);
      await new Promise((r) => setTimeout(r, 400));
    } finally {
      live.disconnect();
    }
    assert.ok(events.some((e) => e.event === 'conversation:assigned' && e.data.conversationId === c)); // the assignment itself is announced
    assert.ok(events.some((e) => e.event === 'activity:new' && e.data.conversationId === c));
    assert.ok(!JSON.stringify(events).includes(SECRET), 'a socket event carried the reason');

    // Every normal read, as an admin (the most privileged normal view)
    const reads: [string, object][] = [
      [`query($id: ID!) { conversation(id: $id) { id status unread assignee { id name color userId conversationCount user { id name email role } } contact { name waId } lastMessage { body } labels { id } } }`, { id: c }],
      [`{ conversations(first: 50) { nodes { id assignee { id name } contact { name } lastMessage { body } } } }`, {}],
      [`query($id: ID!) { messages(conversationId: $id, first: 50) { nodes { id body direction status } } }`, { id: c }],
      [`query($c: ID!) { conversationActivity(conversationId: $c) { id type actorName contactName data createdAt } }`, { c }],
      [`{ notifications { items { id type actorName contactName data } unseen } }`, {}],
      [`{ assignees { id name color conversationCount userId user { id name email role } } }`, {}],
      [`{ workspaceMembers { id name email role } }`, {}],
      [`{ members { userId name email role status } }`, {}],
    ];
    for (const [query, vars] of reads) {
      for (const token of [admin.token, agent.token, sup.token]) {
        if (query.includes('members {') && token !== admin.token) continue; // admin-only query
        const text = JSON.stringify(await ok(query, vars, token));
        for (const reason of [REASON_1, REASON_2, REASON_3, SECRET]) assert.ok(!text.includes(reason), `reason leaked via ${query.slice(0, 40)}`);
      }
    }
    const restList = await rest('GET', '/inbox/conversations', admin.token);
    const restOpen = await rest('GET', `/inbox/conversations/${c}/messages`, admin.token);
    for (const reason of [REASON_1, REASON_2, REASON_3, SECRET]) {
      assert.ok(!JSON.stringify(restList.body).includes(reason));
      assert.ok(!JSON.stringify(restOpen.body).includes(reason));
    }
    // The history entries for assignments carry names only, no reason field
    const history = (await ok(`query($c: ID!) { conversationActivity(conversationId: $c) { type data } }`, { c }, admin.token)).conversationActivity;
    for (const h of history) assert.ok(!('reason' in JSON.parse(h.data ?? '{}')) || JSON.parse(h.data).reason === 'member_removed');
    // No chat-facing type exposes it at all
    for (const typeName of ['Conversation', 'Assignee', 'Activity', 'Message', 'WorkspaceMember', 'TeamMember']) {
      const fields = (await ok(`{ __type(name: "${typeName}") { fields { name } } }`, undefined, admin.token)).__type?.fields?.map((f: any) => f.name) ?? [];
      assert.ok(!fields.includes('reason') && !fields.includes('assignments'), `${typeName} exposes the reason`);
    }
  });

  test('the report: owners and admins only; supervisors, agents, signed-out and other workspaces are refused', async () => {
    assert.equal(await errorCode(REPORT, {}, agent.token), 'FORBIDDEN');
    assert.equal(await errorCode(REPORT, {}, sup.token), 'FORBIDDEN');
    assert.equal(await errorCode(REPORT, {}), 'UNAUTHENTICATED');
    assert.equal(await errorCode(REPORT, {}, 'not-a-token'), 'UNAUTHENTICATED');
    // A label grant doesn't open the report
    await ok(`mutation($u: ID!) { setLabelPermission(userId: $u, canManageLabels: true) { userId } }`, { u: sup.id }, admin.token);
    assert.equal(await errorCode(REPORT, {}, sup.token), 'FORBIDDEN');
    const ours = Object.values(chat);
    assert.ok((await report(B.token)).every((r) => !ours.includes(r.conversationId))); // another workspace's owner sees none of it
    assert.deepEqual(await report(B.token, { c: chat['Reason 1'] }), []); // not even by chat id
    const byOwner = await report(owner.token);
    const byAdmin = await report(admin.token);
    assert.equal(byOwner.length, await prisma.assignmentRecord.count({ where: { workspaceId: ws.workspaceId } })); // every row of this workspace
    assert.deepEqual(byAdmin, byOwner);
    assert.ok(byOwner.every((r) => Object.values(chat).includes(r.conversationId)));
  });

  test('the report lists chat id, previous and new assignee, who assigned, reason and time; newest first; filters by chat and time', async () => {
    const c = chat['Reason 1'];
    const rows = await report(admin.token, { c });
    assert.equal(rows.length, 5);
    assert.deepEqual(
      rows.map((r) => [r.previousAssignee?.name ?? null, r.newAssignee?.name ?? null, r.assignedBy?.name, r.reason]),
      [
        [null, 'Asha', 'Suraj', 'socket-only-secret-reason'], // newest (from the leak test above)
        ['Suraj', null, 'Arun', REASON_3],
        ['Arun', 'Suraj', 'Suraj', 'Escalated'],
        ['Asha', 'Arun', 'Asha', REASON_2],
        [null, 'Asha', 'Adira', REASON_1],
      ],
    );
    const last = rows[0];
    assert.equal(last.conversationId, c);
    assert.equal(last.contactName, 'Reason 1');
    assert.equal(last.contactWaId, '917840000001');
    assert.deepEqual(last.newAssignee, { memberId: await memberId(agent.id), userId: agent.id, name: 'Asha' });
    assert.deepEqual(last.assignedBy, { userId: sup.id, name: 'Suraj' });
    assert.ok(new Date(last.createdAt).getTime() <= Date.now());
    for (let i = 1; i < rows.length; i++) assert.ok(new Date(rows[i - 1].createdAt) >= new Date(rows[i].createdAt));
    // Time window: nothing in the future, everything since yesterday; first caps
    assert.deepEqual(await report(admin.token, { from: new Date(Date.now() + 60_000).toISOString() }), []);
    assert.deepEqual(await report(admin.token, { to: new Date(Date.now() - 86_400_000).toISOString() }), []);
    assert.equal((await report(admin.token, { from: new Date(Date.now() - 86_400_000).toISOString(), c })).length, 5);
    assert.equal((await report(admin.token, { first: 2 })).length, 2);
    assert.equal(await errorCode(REPORT, { from: new Date().toISOString(), to: new Date(Date.now() - 1000).toISOString() }, admin.token), 'BAD_USER_INPUT');
  });

  test('CSV export: admins download a file with every column; everyone else is refused', async () => {
    const csvFetch = (token?: string, qs = '') =>
      fetch(`${API}/reports/assignments.csv${qs}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    assert.equal((await csvFetch()).status, 401);
    assert.equal((await csvFetch('bad-token')).status, 401);
    assert.equal((await csvFetch(agent.token)).status, 403);
    assert.equal((await csvFetch(sup.token)).status, 403);
    assert.equal((await csvFetch(admin.token, '?from=not-a-date')).status, 400);
    const res = await csvFetch(admin.token, `?conversationId=${chat['Reason 1']}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/csv/);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="assignment-report-\d{4}-\d{2}-\d{2}\.csv"/);
    const text = await res.text();
    const lines = text.replace(/^\uFEFF/, '').trimEnd().split('\r\n');
    assert.equal(lines[0], 'Assigned at (UTC),Chat ID,Customer,Customer number,Previous assignee,New assignee,Assigned by,Reason');
    assert.equal(lines.length, 1 + 5); // header + 5 rows (REASON_2's newline stays inside its quoted cell: LF, while rows end with CRLF)
    assert.ok(text.includes(`"${REASON_1.replace(/"/g, '""')}"`)); // quotes doubled, cell quoted
    assert.ok(text.includes(`"${REASON_2}"`)); // newline kept inside the quoted cell
    assert.ok(text.includes(`,${chat['Reason 1']},Reason 1,917840000001,`));
    assert.ok(text.includes(',Suraj,Unassigned,Arun,'));
    // Other workspaces: an empty report, never this one's rows
    const other = await (await csvFetch(B.token)).text();
    for (const id of Object.values(chat)) assert.ok(!other.includes(id));
    assert.ok(!other.includes(REASON_1));
  });

  test('removing a member records the release of their chats (by the admin, no reason) and keeps their name in the report', async () => {
    const c = chat['Reason 4'];
    const temp = await member('Tariq', 'agent');
    await ok(TO_MEMBER, { c, m: temp.id, r: 'Covering tonight' }, admin.token);
    const tempMemberId = await memberId(temp.id);
    await ok(`mutation($u: ID!) { removeMember(userId: $u) }`, { u: temp.id }, admin.token);
    const rows = await report(admin.token, { c });
    assert.deepEqual(
      rows.map((r) => [r.previousAssignee?.name ?? null, r.newAssignee?.name ?? null, r.assignedBy?.name, r.reason]),
      [
        ['Tariq', null, 'Adira', null],
        [null, 'Tariq', 'Adira', 'Covering tonight'],
      ],
    );
    assert.equal(rows[0].previousAssignee.memberId, tempMemberId); // the membership id as it was
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: c } })).assignedToId, null);
  });

  test('live events: new assignee, previous holder and uninvolved admins each get exactly one event per change; the actor none', async () => {
    const c = chat['Reason 3']; // Asha holds it (assigned above)
    const people = { owner, admin, sup, agent, agent2 };
    const sockets: Record<string, Socket> = {};
    const got: Record<string, { event: string; data: any }[]> = {};
    for (const [name, u] of Object.entries(people)) {
      got[name] = [];
      const live = connectSocket(API, { auth: { token: u.token }, transports: ['websocket'], forceNew: true });
      live.onAny((event, data) => /^assignment:/.test(event) && got[name].push({ event, data }));
      await new Promise<void>((resolve, reject) => {
        live.on('connect', () => resolve());
        live.on('connect_error', reject);
      });
      sockets[name] = live;
    }
    const seen = (name: string) => got[name].map((e) => [e.event, e.data.assignee?.userId ?? null, e.data.previous, e.data.actorName, e.data.conversationId === c]);
    const reset = () => Object.values(got).forEach((l) => l.splice(0));
    const settle = () => new Promise((r) => setTimeout(r, 400));
    try {
      // The admin reassigns Asha -> Arun: Arun (you), Asha (removed), owner (changed); the admin (actor) and the supervisor nothing
      await ok(TO_MEMBER, { c, m: agent2.id, r: 'live 1' }, admin.token);
      await settle();
      assert.deepEqual(seen('agent2'), [['assignment:you', agent2.id, 'Asha', 'Adira', true]]);
      assert.deepEqual(seen('agent'), [['assignment:removed', agent2.id, 'Asha', 'Adira', true]]);
      assert.deepEqual(seen('owner'), [['assignment:changed', agent2.id, 'Asha', 'Adira', true]]);
      assert.deepEqual(seen('admin'), []);
      assert.deepEqual(seen('sup'), []);
      reset();
      // The owner unassigns: Arun (removed), admin (changed); nobody else
      await ok(TO_ASSIGNEE, { c, a: null, r: 'live 2' }, owner.token);
      await settle();
      assert.deepEqual(seen('agent2'), [['assignment:removed', null, 'Arun', owner.name, true]]);
      assert.deepEqual(seen('admin'), [['assignment:changed', null, 'Arun', owner.name, true]]);
      assert.deepEqual(seen('owner'), []);
      assert.deepEqual(seen('agent'), []);
      assert.deepEqual(seen('sup'), []);
      reset();
      // An agent takes it with Assign to Me: both admins (changed); the agent nothing
      await ok(TAKE, { c }, agent.token);
      await settle();
      assert.deepEqual(seen('owner'), [['assignment:changed', agent.id, null, 'Asha', true]]);
      assert.deepEqual(seen('admin'), [['assignment:changed', agent.id, null, 'Asha', true]]);
      assert.deepEqual(seen('agent'), []);
      assert.deepEqual(seen('agent2'), []);
      assert.deepEqual(seen('sup'), []);
      reset();
      // The owner assigns to themselves (previous: Asha): Asha (removed), admin (changed); the owner nothing even though they are the new holder
      await ok(TO_MEMBER, { c, m: owner.id, r: 'live 3' }, owner.token);
      await settle();
      assert.deepEqual(seen('agent'), [['assignment:removed', owner.id, 'Asha', owner.name, true]]);
      assert.deepEqual(seen('admin'), [['assignment:changed', owner.id, 'Asha', owner.name, true]]);
      assert.deepEqual(seen('owner'), []);
      reset();
      // A no-op (same holder) sends nothing to anyone
      await ok(TO_MEMBER, { c, m: owner.id, r: 'live 4' }, admin.token);
      await settle();
      for (const name of Object.keys(people)) assert.deepEqual(seen(name), [], name);
      // The reason never travels in any of these events
      assert.ok(!JSON.stringify(got).includes('live '));
    } finally {
      Object.values(sockets).forEach((l) => l.disconnect());
    }
  });

  test('concurrent reassignments: exactly one row per real change, each naming the true previous holder', async () => {
    const c = chat['Reason 5'];
    await ok(TO_MEMBER, { c, m: agent.id, r: 'start' }, admin.token);
    const results = await Promise.all([
      gql(TO_MEMBER, { c, m: agent2.id, r: 'race A' }, admin.token),
      gql(TO_MEMBER, { c, m: sup.id, r: 'race B' }, owner.token),
      gql(TO_ASSIGNEE, { c, a: null, r: 'race C' }, sup.token),
    ]);
    for (const r of results) assert.ok(!r.errors || r.errors[0].extensions?.code === 'ASSIGN_CONFLICT', JSON.stringify(r.errors));
    const rows = await rowsFor(c);
    const changes = results.filter((r) => !r.errors).length;
    assert.equal(rows.length, 1 + changes);
    for (let i = 1; i < rows.length; i++) assert.equal(rows[i].previousMemberId, rows[i - 1].newMemberId); // an unbroken chain
    assert.equal(rows.at(-1)!.newMemberId, (await prisma.conversation.findUniqueOrThrow({ where: { id: c } })).assignedToId);
  });
});

describe('assignment reminders: every tick, each assignee is told about their open assigned chats', () => {
  type U = { id: string; token: string };
  const TO_MEMBER = `mutation($c: ID!, $m: ID, $r: String) { assignConversation(conversationId: $c, memberId: $m, reason: $r) { id } }`;
  const CLOSE = `mutation($c: ID!) { closeConversation(id: $c) { id status } }`;
  let ws: { token: string; workspaceId: string };
  let agent: U;
  let other: U;
  const chat: Record<string, string> = {};
  const sockets: Record<string, Socket> = {};
  const got: Record<string, any[]> = { owner: [], agent: [], other: [] };
  const immediate: Record<string, any[]> = { owner: [], agent: [], other: [] }; // assignment:you, the instant toast
  const OPEN = `mutation($id: ID!) { markConversationRead(id: $id) { id } }`;
  const openedAt = async (c: string) => (await prisma.conversation.findUniqueOrThrow({ where: { id: c } })).assigneeOpenedAt;

  async function member(name: string, role: string): Promise<U> {
    const email = `e2e-remind-${name.toLowerCase()}-${run}@example.com`;
    const user = await prisma.user.create({
      data: { name, email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role, workspaceId: ws.workspaceId } } },
    });
    created.userIds.push(user.id);
    const { login } = await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } });
    return { id: user.id, token: login.token };
  }
  const tick = async () => {
    const r = await rest('POST', '/inbox/dev/assignment-reminders', ws.token);
    assert.equal(r.status, 200);
    await new Promise((res) => setTimeout(res, 400));
  };
  const mine = (who: string) => got[who].map((e) => e.chats.map((c: any) => c.contactName));
  const reset = () => Object.values(got).forEach((l) => l.splice(0));

  before(async () => {
    ws = await newWorkspace('remind');
    agent = await member('Rima', 'agent');
    other = await member('Omar', 'agent');
    for (const n of [1, 2, 3, 4])
      await ok(SIMULATE, { i: { waId: `91785000000${n}`, name: `Remind ${n}`, body: 'Still waiting' } }, ws.token);
    for (const c of (await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes) chat[c.contact.name] = c.id;
    for (const [name, u] of [['owner', { token: ws.token }], ['agent', agent], ['other', other]] as const) {
      const live = connectSocket(API, { auth: { token: u.token }, transports: ['websocket'], forceNew: true });
      live.on('assignment:reminder', (data) => got[name].push(data));
      live.on('assignment:you', (data) => immediate[name].push(data));
      await new Promise<void>((resolve, reject) => {
        live.on('connect', () => resolve());
        live.on('connect_error', reject);
      });
      sockets[name] = live;
    }
  });
  after(() => Object.values(sockets).forEach((s) => s.disconnect()));

  test('only the assignee of an open chat is reminded; one event listing all their chats', async () => {
    await tick();
    for (const who of Object.keys(got)) assert.deepEqual(mine(who), [], `${who}: nothing assigned yet`);
    await ok(TO_MEMBER, { c: chat['Remind 1'], m: agent.id, r: 'first' }, ws.token);
    await ok(TO_MEMBER, { c: chat['Remind 2'], m: agent.id, r: 'second' }, ws.token);
    await ok(TO_MEMBER, { c: chat['Remind 3'], m: other.id, r: 'third' }, ws.token);
    await new Promise((r) => setTimeout(r, 300));
    // The instant notification went to each new assignee at once (the reminders below are on top of it)
    assert.deepEqual(immediate.agent.map((e) => e.conversationId), [chat['Remind 1'], chat['Remind 2']]);
    assert.deepEqual(immediate.other.map((e) => e.conversationId), [chat['Remind 3']]);
    assert.deepEqual(immediate.owner, []);
    assert.equal(await openedAt(chat['Remind 1']), null); // not opened yet
    reset();
    await tick();
    assert.deepEqual(mine('agent'), [['Remind 1', 'Remind 2']]); // one event, both chats, oldest waiting first
    assert.deepEqual(mine('other'), [['Remind 3']]);
    assert.deepEqual(mine('owner'), []); // holds nothing
    const e = got.agent[0];
    assert.ok(typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at)));
    assert.deepEqual(Object.keys(e.chats[0]).sort(), ['contactName', 'conversationId', 'lastMessageAt']);
    assert.equal(e.chats[0].conversationId, chat['Remind 1']);
    assert.ok(!JSON.stringify(got).includes('first')); // never the assignment reason
  });

  test('reminders repeat every tick while the chat stays open and assigned, even after the agent replies', async () => {
    reset();
    await tick();
    await tick();
    assert.deepEqual(mine('agent'), [['Remind 1', 'Remind 2'], ['Remind 1', 'Remind 2']]);
    // Rima answers Remind 1: it is still open and hers, so it is still on the list (newest activity last)
    await prisma.message.create({ data: { conversationId: chat['Remind 1'], direction: 'out', type: 'text', body: 'On it', status: 'sent', sentById: agent.id } });
    await prisma.conversation.update({ where: { id: chat['Remind 1'] }, data: { lastMessageAt: new Date() } });
    reset();
    await tick();
    assert.deepEqual(mine('agent'), [['Remind 2', 'Remind 1']]);
    // A chat with no messages at all is reminded too
    const empty = await prisma.conversation.create({ data: { workspaceId: ws.workspaceId, contactId: (await prisma.contact.create({ data: { workspaceId: ws.workspaceId, waId: '917850000099', name: 'Remind Empty' } })).id, assignedToId: (await prisma.member.findUniqueOrThrow({ where: { userId_workspaceId: { userId: agent.id, workspaceId: ws.workspaceId } } })).id } });
    reset();
    await tick();
    assert.deepEqual(mine('agent'), [['Remind 2', 'Remind 1', 'Remind Empty']]);
    await prisma.conversation.delete({ where: { id: empty.id } });
  });

  test('opening the chat stops its reminders for that chat only; other pending chats go on; reassignment starts them again', async () => {
    // Rima opens Remind 2 (what the Inbox does when a chat is selected): recorded in the database and visible to
    // the list (assigneeOpenedAt), which shows unopened assignments bold
    const GET = `query($id: ID!) { conversation(id: $id) { assigneeOpenedAt } }`;
    assert.equal((await ok(GET, { id: chat['Remind 2'] }, agent.token)).conversation.assigneeOpenedAt, null);
    await ok(OPEN, { id: chat['Remind 2'] }, agent.token);
    assert.ok(await openedAt(chat['Remind 2']));
    assert.ok((await ok(GET, { id: chat['Remind 2'] }, agent.token)).conversation.assigneeOpenedAt);
    assert.equal(await openedAt(chat['Remind 1']), null);
    reset();
    await tick();
    assert.deepEqual(mine('agent'), [['Remind 1']]); // Remind 2 is done; Remind 1 still pending
    assert.deepEqual(mine('other'), [['Remind 3']]); // untouched
    // Opening it again, or someone else opening Remind 1 (the owner, Omar), changes nothing
    await ok(OPEN, { id: chat['Remind 2'] }, agent.token);
    await ok(OPEN, { id: chat['Remind 1'] }, ws.token);
    await ok(OPEN, { id: chat['Remind 1'] }, other.token);
    assert.equal(await openedAt(chat['Remind 1']), null);
    reset();
    await tick();
    assert.deepEqual(mine('agent'), [['Remind 1']]);
    // Reassigning Remind 2 to Omar: a fresh start for him, Rima's earlier opening doesn't count
    await ok(TO_MEMBER, { c: chat['Remind 2'], m: other.id, r: 'handover' }, ws.token);
    assert.equal(await openedAt(chat['Remind 2']), null);
    reset();
    await tick();
    assert.deepEqual(mine('agent'), [['Remind 1']]);
    assert.deepEqual(mine('other'), [['Remind 2', 'Remind 3']]); // quietest chat first
    // Omar opens Remind 2, then it comes back to Rima: pending for her again until she opens it
    await ok(OPEN, { id: chat['Remind 2'] }, other.token);
    reset();
    await tick();
    assert.deepEqual(mine('other'), [['Remind 3']]);
    await ok(TO_MEMBER, { c: chat['Remind 2'], m: agent.id, r: 'back' }, ws.token);
    reset();
    await tick();
    assert.deepEqual(mine('agent'), [['Remind 2', 'Remind 1']]); // Remind 1 had the newer message
    assert.deepEqual(mine('other'), [['Remind 3']]);
    // Several pending chats: one event per tick listing all of them, repeated every tick until each is opened
    await tick();
    assert.deepEqual(mine('agent'), [['Remind 2', 'Remind 1'], ['Remind 2', 'Remind 1']]);
  });

  test('closing, unassigning or reassigning a chat stops its reminders at once; the new assignee gets them instead', async () => {
    await ok(CLOSE, { c: chat['Remind 2'] }, ws.token); // closed
    reset();
    await tick();
    assert.deepEqual(mine('agent'), [['Remind 1']]);
    await ok(TO_MEMBER, { c: chat['Remind 1'], m: other.id, r: 'handover' }, ws.token); // reassigned to Omar
    reset();
    await tick();
    assert.deepEqual(mine('agent'), []);
    assert.deepEqual(mine('other'), [['Remind 3', 'Remind 1']]);
    await ok(`mutation($c: ID!) { assignConversation(conversationId: $c, assigneeId: null) { id } }`, { c: chat['Remind 1'] }, ws.token); // unassigned
    reset();
    await tick();
    assert.deepEqual(mine('other'), [['Remind 3']]);
    assert.deepEqual(mine('owner'), []);
  });

  test('a deactivated assignee is not reminded; nobody outside the workspace hears anything', async () => {
    await ok(`mutation($u: ID!, $a: Boolean!) { setMemberActive(userId: $u, active: $a) { active } }`, { u: other.id, a: false }, ws.token);
    reset();
    await tick();
    assert.deepEqual(mine('other'), []); // their socket was closed on deactivation anyway; nothing is emitted for them
    assert.deepEqual(mine('agent'), []);
    assert.deepEqual(mine('owner'), []);
    const outsider = connectSocket(API, { auth: { token: B.token }, transports: ['websocket'], forceNew: true });
    const heard: any[] = [];
    outsider.onAny((event, data) => /reminder/.test(event) && heard.push(data));
    await new Promise<void>((resolve) => outsider.on('connect', () => resolve()));
    await ok(`mutation($u: ID!, $a: Boolean!) { setMemberActive(userId: $u, active: $a) { active } }`, { u: other.id, a: true }, ws.token);
    await tick();
    outsider.disconnect();
    assert.ok(!JSON.stringify(heard).includes('Remind'));
  });

  test('the REST open route (GET messages) counts as opening too', async () => {
    const c = chat['Remind 4'];
    await ok(TO_MEMBER, { c, m: agent.id, r: 'rest' }, ws.token);
    assert.equal(await openedAt(c), null);
    assert.equal((await rest('GET', `/inbox/conversations/${c}/messages`, ws.token)).status, 200); // the owner: not the assignee
    assert.equal(await openedAt(c), null);
    assert.equal((await rest('GET', `/inbox/conversations/${c}/messages`, agent.token)).status, 200);
    assert.ok(await openedAt(c));
    reset();
    await tick();
    assert.deepEqual(mine('agent'), []);
  });

  test('the dev trigger is signed-in only; the production build has no trigger and runs the schedule instead', async () => {
    assert.equal((await rest('POST', '/inbox/dev/assignment-reminders', 'not-a-token')).status, 401);
  });
});

describe('chat search: one box for name, number, message, label, assignee and status', () => {
  const SEARCH = `query($q: String, $status: String) { conversations(search: $q, status: $status) { nodes { contact { name } } } }`;
  let ws: { token: string; workspaceId: string };
  let agent: { id: string; token: string };
  const chat: Record<string, string> = {};
  const names = async (q: string | null, token = ws.token, status?: string) =>
    (await ok(SEARCH, { q, status }, token)).conversations.nodes.map((c: any) => c.contact.name).sort();

  before(async () => {
    ws = await newWorkspace('search');
    const email = `e2e-search-agent-${run}@example.com`;
    const user = await prisma.user.create({ data: { name: 'Nikhil Patel', email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role: 'agent', workspaceId: ws.workspaceId } } } });
    created.userIds.push(user.id);
    agent = { id: user.id, token: (await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } })).login.token };
    for (const [w, n, body] of [
      ['971501112233', 'Riya Sharma', 'Do you have 205/55 R16 Michelin?'],
      ['971509998877', 'Aman Verma', 'Price for Bridgestone please'],
      ['919876501234', 'Zoya Khan', 'Hello'],
    ])
      await ok(SIMULATE, { i: { waId: w, name: n, body } }, ws.token);
    for (const c of (await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes) chat[c.contact.name] = c.id;
    // An older message that is no longer the last one (only the server search can find it)
    await ok(SIMULATE, { i: { waId: '919876501234', name: 'Zoya Khan', body: 'Need Pirelli tyres urgently' } }, ws.token);
    await ok(SIMULATE, { i: { waId: '919876501234', name: 'Zoya Khan', body: 'Are you open today?' } }, ws.token);
    const vip = (await ok(`mutation { createLabel(input: { name: "VIP customer", color: "#d63384" }) { id } }`, undefined, ws.token)).createLabel;
    await ok(`mutation($c: ID!, $l: ID!) { addConversationLabel(conversationId: $c, labelId: $l) { id } }`, { c: chat['Riya Sharma'], l: vip.id }, ws.token);
    await ok(`mutation($c: ID!, $m: ID, $r: String) { assignConversation(conversationId: $c, memberId: $m, reason: $r) { id } }`, { c: chat['Aman Verma'], m: agent.id, r: 'search test' }, ws.token);
    await ok(`mutation($id: ID!) { closeConversation(id: $id) { id } }`, { id: chat['Riya Sharma'] }, ws.token);
  });

  test('empty search lists everything; name and phone digits match as substrings, case-insensitively', async () => {
    assert.deepEqual(await names(null), ['Aman Verma', 'Riya Sharma', 'Zoya Khan']);
    assert.deepEqual(await names(''), ['Aman Verma', 'Riya Sharma', 'Zoya Khan']);
    assert.deepEqual(await names('   '), ['Aman Verma', 'Riya Sharma', 'Zoya Khan']);
    assert.deepEqual(await names('riya'), ['Riya Sharma']);
    assert.deepEqual(await names('SHARMA'), ['Riya Sharma']);
    assert.deepEqual(await names('+971 50'), ['Aman Verma', 'Riya Sharma']);
    assert.deepEqual(await names('9876-50'), ['Zoya Khan']);
    assert.deepEqual(await names('nobody here'), []);
  });

  test('any message in the chat, not only the last one; deleted message text is not searched', async () => {
    assert.deepEqual(await names('michelin'), ['Riya Sharma']);
    assert.deepEqual(await names('pirelli'), ['Zoya Khan']); // an older message
    assert.deepEqual(await names('205/55'), ['Riya Sharma']);
    const m = await prisma.message.findFirstOrThrow({ where: { conversationId: chat['Aman Verma'], body: { contains: 'Bridgestone' } } });
    await prisma.message.update({ where: { id: m.id }, data: { deletedAt: new Date(), body: '' } });
    assert.deepEqual(await names('bridgestone'), []);
  });

  test('label name, assignee name and the status words; combined with the other filters', async () => {
    assert.deepEqual(await names('vip'), ['Riya Sharma']);
    assert.deepEqual(await names('nikhil'), ['Aman Verma']);
    assert.deepEqual(await names('patel'), ['Aman Verma']);
    assert.deepEqual(await names('closed'), ['Riya Sharma']);
    assert.deepEqual(await names('open'), ['Aman Verma', 'Zoya Khan']); // the status word (Zoya's "open today?" message matches too)
    assert.deepEqual(await names('unassigned'), ['Riya Sharma', 'Zoya Khan']);
    assert.deepEqual(await names('assigned'), ['Aman Verma']);
    assert.deepEqual(await names('unread'), ['Aman Verma', 'Riya Sharma', 'Zoya Khan']);
    await ok(`mutation($id: ID!) { markConversationRead(id: $id) { id } }`, { id: chat['Zoya Khan'] }, ws.token);
    assert.deepEqual(await names('unread'), ['Aman Verma', 'Riya Sharma']);
    assert.deepEqual(await names('a', ws.token, 'closed'), ['Riya Sharma']); // search inside the status filter
    assert.deepEqual(await names('zoya', ws.token, 'closed'), []);
  });

  test('scoped to the workspace and to signed-in users; an over-long term is refused', async () => {
    assert.deepEqual(await names('riya', B.token), []);
    assert.deepEqual(await names('michelin', agent.token), ['Riya Sharma']); // any member of this workspace
    assert.equal(await errorCode(SEARCH, { q: 'riya' }), 'UNAUTHENTICATED');
    assert.equal(await errorCode(SEARCH, { q: 'x'.repeat(101) }, ws.token), 'BAD_USER_INPUT');
  });
});

describe('presence: online / away / offline from the live Socket.IO connections', () => {
  const PRESENCE = `{ presence { userId status lastActiveAt } }`;
  let ws: { token: string; workspaceId: string };
  let owner: string;
  let agent: { id: string; token: string };
  const watch: { event: string; data: any }[] = [];
  let watcher: Socket;
  const statusOf = async (userId: string, token = ws.token) =>
    (await ok(PRESENCE, undefined, token)).presence.find((p: any) => p.userId === userId)?.status ?? 'offline';
  const connect = (token: string) => {
    const s = connectSocket(API, { auth: { token }, transports: ['websocket'], forceNew: true });
    return new Promise<Socket>((resolve, reject) => {
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
  };
  const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
  const sweep = (idleMs: number) => rest('POST', '/inbox/dev/presence-sweep', ws.token, { idleMs });

  before(async () => {
    ws = await newWorkspace('presence');
    owner = (await ok(`{ me { user { id } } }`, undefined, ws.token)).me.user.id;
    const email = `e2e-presence-agent-${run}@example.com`;
    const user = await prisma.user.create({ data: { name: 'Pia', email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role: 'agent', workspaceId: ws.workspaceId } } } });
    created.userIds.push(user.id);
    agent = { id: user.id, token: (await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } })).login.token };
    watcher = await connect(ws.token); // the owner's tab, watching everyone's presence
    watcher.on('presence:update', (data) => watch.push({ event: 'presence:update', data }));
  });
  after(() => watcher?.disconnect());

  test('connecting makes you online for the whole workspace; the list and the live event agree', async () => {
    assert.equal(await statusOf(agent.id), 'offline'); // never connected
    const tab1 = await connect(agent.token);
    await settle();
    assert.equal(await statusOf(agent.id), 'online');
    assert.equal(await statusOf(owner), 'online'); // the watcher's own connection
    const seen = watch.filter((e) => e.data.userId === agent.id).map((e) => e.data.status);
    assert.deepEqual(seen, ['online']);
    assert.ok(typeof (await ok(PRESENCE, undefined, agent.token)).presence.find((p: any) => p.userId === agent.id).lastActiveAt === 'string');
    // presence:list over the socket gives the same picture
    const list: any[] = await new Promise((resolve) => tab1.emit('presence:list', resolve));
    assert.equal(list.find((p) => p.userId === agent.id)?.status, 'online');
    (globalThis as any).__tab1 = tab1;
  });

  test('away after inactivity, back online on activity (from any tab); multiple tabs stay online until the last one closes', async () => {
    const tab1: Socket = (globalThis as any).__tab1;
    const tab2 = await connect(agent.token); // second device
    await settle();
    watch.length = 0;
    assert.equal((await sweep(0)).status, 200); // "everyone idle for 0 ms": the agent (and the owner's watcher) go Away
    await settle();
    assert.equal(await statusOf(agent.id), 'away');
    assert.ok(watch.some((e) => e.data.userId === agent.id && e.data.status === 'away'));
    watch.length = 0;
    tab2.emit('presence:activity'); // moves the mouse on the second device
    await settle();
    assert.equal(await statusOf(agent.id), 'online');
    assert.deepEqual(watch.filter((e) => e.data.userId === agent.id).map((e) => e.data.status), ['online']);
    // Activity within the away window keeps them online through a sweep at the real threshold
    assert.equal((await sweep(60_000)).status, 200);
    await settle();
    assert.equal(await statusOf(agent.id), 'online');
    // Closing one tab: still online (the other device). Closing the last: offline after the short grace period
    watch.length = 0;
    tab1.disconnect();
    await settle(800);
    assert.equal(await statusOf(agent.id), 'online');
    assert.deepEqual(watch.filter((e) => e.data.userId === agent.id), []);
    tab2.disconnect();
    await settle(800);
    assert.equal(await statusOf(agent.id), 'online'); // grace period: a reconnect wouldn't flicker
    await settle(5_000);
    assert.equal(await statusOf(agent.id), 'offline');
    assert.deepEqual(watch.filter((e) => e.data.userId === agent.id).map((e) => e.data.status), ['offline']);
  });

  test('a quick reconnect never shows offline; deactivation drops them at once; other workspaces see nothing', async () => {
    const tab = await connect(agent.token);
    await settle();
    watch.length = 0;
    tab.disconnect();
    await settle(500);
    const again = await connect(agent.token); // back within the grace period
    await settle(5_500);
    assert.equal(await statusOf(agent.id), 'online');
    assert.deepEqual(watch.filter((e) => e.data.userId === agent.id).map((e) => e.data.status), []); // no offline/online flicker
    // Another workspace's owner can't see this workspace's presence
    assert.ok(!(await ok(PRESENCE, undefined, B.token)).presence.some((p: any) => p.userId === agent.id));
    assert.equal(await errorCode(PRESENCE), 'UNAUTHENTICATED');
    // Deactivated: connection closed and presence gone immediately
    watch.length = 0;
    await ok(`mutation($u: ID!, $a: Boolean!) { setMemberActive(userId: $u, active: $a) { active } }`, { u: agent.id, a: false }, ws.token);
    await settle(500);
    assert.equal(await statusOf(agent.id), 'offline');
    assert.deepEqual(watch.filter((e) => e.data.userId === agent.id).map((e) => e.data.status), ['offline']);
    assert.equal(again.connected, false);
    await ok(`mutation($u: ID!, $a: Boolean!) { setMemberActive(userId: $u, active: $a) { active } }`, { u: agent.id, a: true }, ws.token);
  });

  test('the activity ping is rate limited and the sweep trigger needs a sign-in', async () => {
    assert.equal((await rest('POST', '/inbox/dev/presence-sweep', 'not-a-token', { idleMs: 0 })).status, 401);
    const tab = await connect(agent.token);
    for (let i = 0; i < 200; i++) tab.emit('presence:activity'); // flood: ignored beyond the limit, no error, still online
    await settle();
    assert.equal(await statusOf(agent.id), 'online');
    tab.disconnect();
  });
});

describe('notification visibility: each person sees their own, owners and admins see everything', () => {
  type U = { id: string; token: string };
  const FEED = `{ notifications { unseen items { id type contactName data } } }`;
  const TO_MEMBER = `mutation($c: ID!, $m: ID, $r: String) { assignConversation(conversationId: $c, memberId: $m, reason: $r) { id } }`;
  let ws: { token: string; workspaceId: string };
  let admin: U;
  let sup: U;
  let asha: U;
  let arun: U;
  const chat: Record<string, string> = {};
  const feed = async (token: string) => (await ok(FEED, undefined, token)).notifications as { unseen: number; items: { id: string; type: string; contactName: string; data: string | null }[] };
  const seen = async (token: string) => (await feed(token)).items.map((i) => `${i.type}:${i.contactName}`);

  async function member(name: string, role: string): Promise<U> {
    const email = `e2e-notif-${name.toLowerCase()}-${run}@example.com`;
    const user = await prisma.user.create({ data: { name, email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role, workspaceId: ws.workspaceId } } } });
    created.userIds.push(user.id);
    return { id: user.id, token: (await ok(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } })).login.token };
  }

  before(async () => {
    ws = await newWorkspace('notif');
    admin = await member('Adi', 'admin');
    sup = await member('Sana', 'supervisor');
    asha = await member('Asha', 'agent');
    arun = await member('Arun', 'agent');
    for (const n of [1, 2, 3]) await ok(SIMULATE, { i: { waId: `91786000000${n}`, name: `Notif ${n}`, body: 'hi' } }, ws.token);
    for (const c of (await ok(CONVERSATIONS, {}, ws.token)).conversations.nodes) chat[c.contact.name] = c.id;
  });

  test('before anything is assigned: agents and supervisors see nothing; owner and admin see the customer messages', async () => {
    assert.deepEqual(await seen(asha.token), []);
    assert.deepEqual(await seen(arun.token), []);
    assert.deepEqual(await seen(sup.token), []);
    assert.deepEqual((await seen(ws.token)).sort(), ['message_received:Notif 1', 'message_received:Notif 2', 'message_received:Notif 3']);
    assert.deepEqual((await seen(admin.token)).sort(), ['message_received:Notif 1', 'message_received:Notif 2', 'message_received:Notif 3']);
    assert.equal((await feed(asha.token)).unseen, 0);
    assert.equal((await feed(admin.token)).unseen, 3);
  });

  test('an assignment is seen by the person it names and by admins; the other agent never sees it', async () => {
    await ok(TO_MEMBER, { c: chat['Notif 1'], m: asha.id, r: 'yours' }, ws.token);
    await ok(TO_MEMBER, { c: chat['Notif 2'], m: arun.id, r: 'yours' }, ws.token);
    // Asha: her assignment plus everything on her chat (the earlier customer message, now that the chat is hers)
    assert.deepEqual((await seen(asha.token)).sort(), ['assigned:Notif 1', 'message_received:Notif 1']);
    assert.deepEqual((await seen(arun.token)).sort(), ['assigned:Notif 2', 'message_received:Notif 2']);
    assert.deepEqual(await seen(sup.token), []); // holds nothing
    assert.equal((await feed(admin.token)).items.filter((i) => i.type === 'assigned').length, 2);
    assert.ok(!(await feed(asha.token)).items.some((i) => i.contactName === 'Notif 2' || i.contactName === 'Notif 3'));
    assert.equal((await feed(asha.token)).unseen, 2);
  });

  test("events on someone else's chat (label, close, customer message) stay out of your bell; your own chat's are in", async () => {
    const label = (await ok(`mutation { createLabel(input: { name: "Hot", color: "#d63384" }) { id } }`, undefined, ws.token)).createLabel;
    await ok(`mutation($c: ID!, $l: ID!) { addConversationLabel(conversationId: $c, labelId: $l) { id } }`, { c: chat['Notif 2'], l: label.id }, admin.token); // Arun's chat
    await ok(SIMULATE, { i: { waId: '917860000002', name: 'Notif 2', body: 'still there?' } }, ws.token); // customer writes to Arun's chat
    await ok(SIMULATE, { i: { waId: '917860000001', name: 'Notif 1', body: 'hello?' } }, ws.token); // and to Asha's
    assert.deepEqual((await seen(arun.token)).sort(), ['assigned:Notif 2', 'label_added:Notif 2', 'message_received:Notif 2', 'message_received:Notif 2']);
    assert.deepEqual((await seen(asha.token)).sort(), ['assigned:Notif 1', 'message_received:Notif 1', 'message_received:Notif 1']);
    assert.ok((await feed(ws.token)).items.some((i) => i.type === 'label_added')); // the owner (who didn't do it) sees it
    assert.ok(!(await feed(admin.token)).items.some((i) => i.type === 'label_added')); // the admin did it: not their own bell
    // Your own actions are never in your bell, whatever your role
    await ok(`mutation($id: ID!) { closeConversation(id: $id) { id } }`, { id: chat['Notif 1'] }, asha.token);
    assert.ok(!(await feed(asha.token)).items.some((i) => i.type === 'conversation_closed'));
    assert.ok((await feed(admin.token)).items.some((i) => i.type === 'conversation_closed' && i.contactName === 'Notif 1'));
    await ok(`mutation($id: ID!) { reopenConversation(id: $id) { id } }`, { id: chat['Notif 1'] }, ws.token);
  });

  test('reassigning moves the chat out of the old assignee\'s bell (keeping the assignment that named them) and into the new one\'s', async () => {
    await ok(TO_MEMBER, { c: chat['Notif 1'], m: arun.id, r: 'handover' }, admin.token);
    const ashaNow = await seen(asha.token);
    assert.ok(ashaNow.includes('assigned:Notif 1')); // the assignment that named her stays
    assert.ok(!ashaNow.includes('message_received:Notif 1')); // the chat's other events are no longer hers
    assert.ok((await seen(arun.token)).includes('reassigned:Notif 1'));
    assert.ok((await seen(arun.token)).includes('message_received:Notif 1'));
  });

  test('live: the bell event goes only to the people allowed to see it; the chat timeline event still reaches everyone', async () => {
    const got: Record<string, { event: string; data: any }[]> = {};
    const sockets: Socket[] = [];
    for (const [name, u] of [['owner', ws], ['admin', admin], ['sup', sup], ['asha', asha], ['arun', arun]] as const) {
      got[name] = [];
      const live = connectSocket(API, { auth: { token: u.token }, transports: ['websocket'], forceNew: true });
      live.on('notification:new', (data) => got[name].push({ event: 'notification:new', data }));
      live.on('activity:new', (data) => got[name].push({ event: 'activity:new', data }));
      await new Promise<void>((resolve, reject) => {
        live.on('connect', () => resolve());
        live.on('connect_error', reject);
      });
      sockets.push(live);
    }
    try {
      await ok(SIMULATE, { i: { waId: '917860000003', name: 'Notif 3', body: 'anyone?' } }, ws.token); // unassigned chat: admins only
      await ok(TO_MEMBER, { c: chat['Notif 3'], m: asha.id, r: 'take it' }, sup.token); // names Asha; the supervisor did it
      await new Promise((r) => setTimeout(r, 500));
      const bell = (name: string) => got[name].filter((e) => e.event === 'notification:new').map((e) => e.data.type);
      const timeline = (name: string) => got[name].filter((e) => e.event === 'activity:new').map((e) => e.data.type);
      assert.deepEqual(bell('owner'), ['message_received', 'assigned']);
      assert.deepEqual(bell('admin'), ['message_received', 'assigned']);
      assert.deepEqual(bell('asha'), ['assigned']);
      assert.deepEqual(bell('arun'), []);
      assert.deepEqual(bell('sup'), []); // did the assignment: not notified of their own action, and holds nothing
      for (const name of Object.keys(got)) assert.deepEqual(timeline(name), ['message_received', 'assigned'], name);
    } finally {
      sockets.forEach((s) => s.disconnect());
    }
  });

  test('a removed member and other workspaces get nothing; signed-out requests are refused', async () => {
    const gone = await member('Gita', 'agent');
    await ok(TO_MEMBER, { c: chat['Notif 3'], m: gone.id, r: 'temp' }, ws.token);
    assert.ok((await seen(gone.token)).includes('reassigned:Notif 3'));
    await ok(`mutation($u: ID!) { removeMember(userId: $u) }`, { u: gone.id }, ws.token);
    assert.equal(await errorCode(FEED, undefined, gone.token), 'UNAUTHENTICATED');
    assert.ok(!(await feed(B.token)).items.some((i) => i.contactName?.startsWith('Notif')));
    assert.equal(await errorCode(FEED), 'UNAUTHENTICATED');
  });
});
