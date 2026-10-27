// Push notifications (services/push.ts): device registration, who is notified for a customer's WhatsApp message and
// for an assignment, the payload the Flutter app reads (data.conversationId / data.kind), tokens Firebase reports as
// gone, and the service account handling. Runs in-process against the local database with a fake Firebase sender:
// nothing is sent to Google. Run: npm run test:e2e (picks up test/*.test.ts)
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Message } from 'firebase-admin/messaging';
import { env } from '../src/env.js';
import { prisma } from '../src/prisma.js';
import { saveIncoming } from '../src/messages.js';
import { assignConversation } from '../src/services/assign.js';
import { pushConfigured, pushPreview, pushToUsers, registerPushDevice, setPushSenderForTests, unregisterPushDevice } from '../src/services/push.js';

const run = Date.now();
let ws = '';
const people: Record<string, { userId: string; memberId: string }> = {};
const created: string[] = [];
// A fake Firebase: records every message; tokens listed in `gone` / `broken` fail the way Firebase does
let sent: Message[] = [];
const gone = new Set<string>();
const broken = new Set<string>();
const fake = {
  send: async (m: Message) => {
    const token = (m as { token: string }).token;
    if (gone.has(token)) throw Object.assign(new Error('Requested entity was not found.'), { code: 'messaging/registration-token-not-registered' });
    if (broken.has(token)) throw Object.assign(new Error('Internal error'), { code: 'messaging/internal-error' });
    sent.push(m);
    return `projects/test/messages/${sent.length}`;
  },
};
const tokenOf = (name: string) => `fcm-token-${name}-${run}-${'x'.repeat(40)}`;
const auth = (name: string) => ({ userId: people[name].userId, workspaceId: ws });
const to = () => sent.map((m) => (m as { token: string }).token).sort();
const tokens = (...names: string[]) => names.map(tokenOf).sort();
// Background sends (void pushCustomerMessage / pushToUsers) finish shortly after the action
const settle = () => new Promise((r) => setTimeout(r, 300));
const number = (n: number) => `97150${String(run + n).slice(-7)}`;

before(async () => {
  const w = await prisma.workspace.create({ data: { name: `e2e-push-${run}` } });
  ws = w.id;
  for (const [name, role, active] of [
    ['owner', 'owner', true],
    ['sup', 'supervisor', true],
    ['agentA', 'agent', true],
    ['agentB', 'agent', true],
    ['gone', 'agent', false], // deactivated: never notified
  ] as const) {
    const u = await prisma.user.create({ data: { name: `Push ${name}`, email: `e2e-push-${name}-${run}@example.com`, passwordHash: 'x', members: { create: { role, workspaceId: ws, active } } }, include: { members: true } });
    created.push(u.id);
    people[name] = { userId: u.id, memberId: u.members[0].id };
  }
});
after(async () => {
  setPushSenderForTests(undefined);
  await prisma.pushDevice.deleteMany({ where: { workspaceId: ws } });
  await prisma.workspace.deleteMany({ where: { id: ws } });
  await prisma.user.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});
beforeEach(() => {
  sent = [];
  gone.clear();
  broken.clear();
});

describe('off until a Firebase service account is configured', () => {
  test('not configured: pushConfigured is false and registering stores nothing', async () => {
    setPushSenderForTests(undefined);
    const saved = { json: env.firebaseServiceAccount, file: env.firebaseServiceAccountFile };
    env.firebaseServiceAccount = '';
    env.firebaseServiceAccountFile = '';
    try {
      assert.equal(pushConfigured(), false);
      assert.equal(await registerPushDevice(auth('owner'), { token: tokenOf('owner'), platform: 'android' }), false);
      assert.equal(await prisma.pushDevice.count({ where: { workspaceId: ws } }), 0);
    } finally {
      Object.assign(env, { firebaseServiceAccount: saved.json, firebaseServiceAccountFile: saved.file });
      setPushSenderForTests(undefined);
    }
  });

  test('an unusable service account keeps push off and never echoes the key', async () => {
    const saved = { json: env.firebaseServiceAccount, file: env.firebaseServiceAccountFile };
    const secret = 'SECRET-KEY-MATERIAL-123';
    try {
      for (const [json, file] of [
        [`{"private_key": "${secret}"`, ''], // not JSON
        [JSON.stringify({ project_id: 'p', client_email: 'e@x.iam.gserviceaccount.com', private_key: secret }), ''], // not a key
        ['', '/nonexistent/firebase-sa.json'], // unreadable file
      ]) {
        env.firebaseServiceAccount = json;
        env.firebaseServiceAccountFile = file;
        setPushSenderForTests(undefined);
        const errors: string[] = [];
        const original = console.error;
        console.error = (...a: unknown[]) => void errors.push(a.join(' '));
        try {
          assert.equal(pushConfigured(), false);
        } finally {
          console.error = original;
        }
        assert.equal(errors.length, 1);
        assert.ok(!errors[0].includes(secret), errors[0]);
      }
      await settle();
      const logged = await prisma.logEntry.findMany({ where: { event: 'push.config_invalid', createdAt: { gte: new Date(run) } } });
      assert.ok(logged.length >= 3);
      assert.ok(logged.every((l) => !JSON.stringify(l).includes(secret)));
      // A well-formed account switches it on (Firebase itself is only contacted when sending)
      env.firebaseServiceAccountFile = '';
      env.firebaseServiceAccount = JSON.stringify({ project_id: 'p', client_email: 'e@x.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' });
      setPushSenderForTests(undefined);
      assert.equal(pushConfigured(), true);
    } finally {
      Object.assign(env, { firebaseServiceAccount: saved.json, firebaseServiceAccountFile: saved.file });
      setPushSenderForTests(undefined);
    }
  });
});

describe('device registration', () => {
  before(() => setPushSenderForTests(fake, true));

  test('validates the token and platform', async () => {
    await assert.rejects(registerPushDevice(auth('owner'), { token: 'short', platform: 'android' }), /Invalid device token/);
    await assert.rejects(registerPushDevice(auth('owner'), { token: tokenOf('owner'), platform: 'windows' }));
    await assert.rejects(registerPushDevice(auth('owner'), {}));
  });

  test('stores the phone for the signed-in person and workspace; registering again updates it, never duplicates', async () => {
    for (const name of ['owner', 'sup', 'agentA', 'agentB', 'gone']) assert.equal(await registerPushDevice(auth(name), { token: tokenOf(name), platform: 'android' }), true);
    assert.equal(await registerPushDevice(auth('owner'), { token: tokenOf('owner'), platform: 'ios' }), true);
    const owner = await prisma.pushDevice.findMany({ where: { token: tokenOf('owner') } });
    assert.equal(owner.length, 1);
    assert.deepEqual([owner[0].userId, owner[0].workspaceId, owner[0].platform], [people.owner.userId, ws, 'ios']);
    assert.equal(await prisma.pushDevice.count({ where: { workspaceId: ws } }), 5);
  });

  test("someone else signing in on a phone takes it over; signing out removes only your own phone", async () => {
    const shared = tokenOf('shared');
    await registerPushDevice(auth('agentA'), { token: shared, platform: 'android' });
    await registerPushDevice(auth('agentB'), { token: shared, platform: 'android' });
    assert.equal((await prisma.pushDevice.findUniqueOrThrow({ where: { token: shared } })).userId, people.agentB.userId);
    assert.equal(await unregisterPushDevice(auth('agentA'), shared), false, "not agentA's phone any more");
    assert.equal(await unregisterPushDevice(auth('agentB'), shared), true);
    assert.equal(await prisma.pushDevice.count({ where: { token: shared } }), 0);
    assert.equal(await unregisterPushDevice(auth('agentB'), ''), false);
  });

  test('tokens are never written to the log', async () => {
    await settle();
    const rows = await prisma.logEntry.findMany({ where: { workspaceId: ws, event: { startsWith: 'push.' } } });
    assert.ok(rows.some((r) => r.event === 'push.device_registered'));
    assert.ok(rows.every((r) => !JSON.stringify(r).includes('fcm-token-')));
  });
});

describe('a customer WhatsApp message', () => {
  let conversationId = '';
  before(() => setPushSenderForTests(fake, true));

  test('unassigned chat: every active teammate is notified once (not deactivated members), with the chat to open', async () => {
    const body = `Is my order ready? ${run}`;
    const message = await saveIncoming(ws, { waId: number(1), name: 'Asha', type: 'text', body, waMessageId: `wamid.push-${run}-1` });
    conversationId = message.conversationId;
    await settle();
    assert.deepEqual(to(), tokens('owner', 'sup', 'agentA', 'agentB'));
    const m = sent[0] as Message & { notification: { title: string; body: string }; data: Record<string, string>; android: { priority: string; collapseKey: string } };
    assert.deepEqual(m.notification, { title: 'Asha', body });
    assert.deepEqual(m.data, { conversationId, kind: 'message' });
    assert.equal(m.android.priority, 'high');
    assert.equal(m.android.collapseKey, conversationId);
    // The log has counts only: no message text, no tokens
    const log = await prisma.logEntry.findFirst({ where: { workspaceId: ws, event: 'push.sent' }, orderBy: { createdAt: 'desc' } });
    assert.ok(log);
    assert.match(log.message, /sent to 4 of 4/);
    assert.ok(!JSON.stringify(log).includes(body) && !JSON.stringify(log).includes('fcm-token-'));
  });

  test('assigned chat: owners, admins and supervisors, the assignee and collaborators; not other agents', async () => {
    await assignConversation(ws, conversationId, people.agentA.memberId, people.owner.userId);
    await prisma.conversationCollaborator.create({ data: { conversationId, userId: people.agentB.userId } });
    await settle();
    sent = [];
    await saveIncoming(ws, { waId: number(1), type: 'image', body: '[image]', waMessageId: `wamid.push-${run}-2`, media: { id: 'media-1', mime: 'image/jpeg' } });
    await settle();
    assert.deepEqual(to(), tokens('owner', 'sup', 'agentA', 'agentB'));
    assert.equal((sent[0] as any).notification.body, '📷 Photo');
    await prisma.conversationCollaborator.deleteMany({ where: { conversationId } });
    sent = [];
    await saveIncoming(ws, { waId: number(1), type: 'text', body: 'hello again', waMessageId: `wamid.push-${run}-3` });
    await settle();
    assert.deepEqual(to(), tokens('owner', 'sup', 'agentA'), 'agentB is neither assignee nor collaborator now');
  });

  test('the same WhatsApp message delivered twice notifies once', async () => {
    const waMessageId = `wamid.push-${run}-dup`;
    await saveIncoming(ws, { waId: number(1), type: 'text', body: 'once', waMessageId });
    await saveIncoming(ws, { waId: number(1), type: 'text', body: 'once', waMessageId }).catch(() => {});
    await settle();
    assert.equal(sent.length, 3);
  });

  test('a phone Firebase reports as gone is forgotten; other failures are logged and the rest still get it', async () => {
    gone.add(tokenOf('sup'));
    broken.add(tokenOf('agentA'));
    await saveIncoming(ws, { waId: number(1), type: 'text', body: 'anyone?', waMessageId: `wamid.push-${run}-4` });
    await settle();
    assert.deepEqual(to(), tokens('owner'));
    assert.equal(await prisma.pushDevice.count({ where: { token: tokenOf('sup') } }), 0, 'uninstalled app: token removed');
    assert.equal(await prisma.pushDevice.count({ where: { token: tokenOf('agentA') } }), 1, 'a temporary failure keeps the token');
    const log = await prisma.logEntry.findFirst({ where: { workspaceId: ws, event: 'push.sent' }, orderBy: { createdAt: 'desc' } });
    assert.equal(log?.level, 'WARNING');
    assert.equal(log?.errorCode, 'messaging/internal-error');
    await registerPushDevice(auth('sup'), { token: tokenOf('sup'), platform: 'android' });
  });

  test('a failing sender never breaks saving the message', async () => {
    setPushSenderForTests({ send: async () => { throw new Error('network down'); } }, true);
    try {
      const m = await saveIncoming(ws, { waId: number(1), type: 'text', body: 'still saved', waMessageId: `wamid.push-${run}-5` });
      await settle();
      assert.ok(await prisma.message.findUnique({ where: { id: m.id } }));
    } finally {
      setPushSenderForTests(fake, true);
    }
  });
});

describe('chat assignment', () => {
  before(() => setPushSenderForTests(fake, true));

  test('the new assignee gets "Chat assigned to you"; nobody else', async () => {
    const m = await saveIncoming(ws, { waId: number(2), name: 'Bilal', type: 'text', body: 'hi', waMessageId: `wamid.push-${run}-b1` });
    await settle();
    sent = [];
    await assignConversation(ws, m.conversationId, people.agentB.memberId, people.owner.userId);
    await settle();
    assert.deepEqual(to(), tokens('agentB'));
    const n = sent[0] as any;
    assert.deepEqual(n.notification, { title: 'Chat assigned to you', body: 'Bilal · by Push owner' });
    assert.deepEqual(n.data, { conversationId: m.conversationId, kind: 'assigned' });
  });

  test('assigning a chat to yourself, or unassigning, sends nothing', async () => {
    const m = await saveIncoming(ws, { waId: number(3), name: 'Chen', type: 'text', body: 'hi', waMessageId: `wamid.push-${run}-c1` });
    await settle();
    sent = [];
    await assignConversation(ws, m.conversationId, people.owner.memberId, people.owner.userId);
    await assignConversation(ws, m.conversationId, null, people.owner.userId);
    await settle();
    assert.deepEqual(sent, []);
  });

  test('a deactivated member is never notified, even when named directly', async () => {
    await pushToUsers(ws, [people.gone.userId], { title: 't', body: 'b', conversationId: 'c', kind: 'assigned', collapseKey: 'k' }, `direct:${run}`);
    assert.deepEqual(sent, []);
  });
});

test('notification text for each WhatsApp message type', () => {
  assert.equal(pushPreview({ type: 'text', body: '  hello\n there ' }), 'hello there');
  assert.equal(pushPreview({ type: 'image', body: '[image]' }), '📷 Photo');
  assert.equal(pushPreview({ type: 'image', body: 'new tyres' }), '📷 new tyres');
  assert.equal(pushPreview({ type: 'video', body: '[video]' }), '🎥 Video');
  assert.equal(pushPreview({ type: 'voice', body: '[audio]' }), '🎤 Voice message');
  assert.equal(pushPreview({ type: 'document', body: '[document]', mediaName: 'invoice.pdf' }), '📄 invoice.pdf');
  assert.equal(pushPreview({ type: 'location', body: 'Home\nhttps://maps.google.com/?q=1,2' }), '📍 Location');
  assert.equal(pushPreview({ type: 'unknown_new_type', body: '' }), 'New message');
});
