// @mentions in internal notes: the mentioned teammate gets the chat in their Mentions list and a live notification
// (mention:you, only to them); only active teammates of the workspace can be mentioned, never yourself. Notes stay
// out of the chat timeline. The API server must be running (API_URL).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import bcrypt from 'bcryptjs';
import { io as connectSocket } from 'socket.io-client';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../src/env.js';
import { prisma } from '../src/prisma.js';

const API = process.env.API_URL ?? 'http://localhost:5001';
const run = Date.now();
const gql = async (query: string, variables: object = {}, token?: string) =>
  (await (await fetch(`${API}/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) })).json()) as any;
const created = { users: [] as string[], workspaces: [] as string[] };
const ADD = `mutation($c: ID!, $b: String!, $m: [ID!]) { addContactRemark(contactId: $c, body: $b, mentions: $m) { id body } }`;
const MENTIONS = `{ conversations(assignee: "mentioned") { nodes { id } } }`;
let ws = '';
const people: Record<string, { id: string; token: string }> = {};

before(async () => {
  const r = (await gql(`mutation($i: RegisterInput!) { register(input: $i) { token user { id } workspace { id } } }`, { i: { name: 'Men Owner', email: `e2e-men-o-${run}@example.com`, password: 'password123', workspaceName: `Mentions ${run}` } })).data.register;
  ws = r.workspace.id;
  people.owner = { id: r.user.id, token: r.token };
  created.workspaces.push(ws);
  created.users.push(r.user.id);
  for (const [key, role] of [['agent', 'agent'], ['sup', 'supervisor']]) {
    const email = `e2e-men-${key}-${run}@example.com`;
    const u = await prisma.user.create({ data: { name: `Men ${key}`, email, passwordHash: await bcrypt.hash('password123', 4), members: { create: { role, workspaceId: ws } } } });
    created.users.push(u.id);
    people[key] = { id: u.id, token: (await gql(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: 'password123' } })).data.login.token };
  }
  await gql(`mutation($i: SimulateIncomingInput) { simulateIncomingMessage(input: $i) }`, { i: { waId: `9715${String(run).slice(-8)}`, name: 'Mention Cust', body: 'hi' } }, people.owner.token);
});
after(async () => {
  const workspaceId = { in: created.workspaces };
  await prisma.remarkFile.deleteMany({ where: { workspaceId } });
  await rm(path.join(env.uploadsDir, ws), { recursive: true, force: true });
  await prisma.contactRemark.deleteMany({ where: { contact: { workspaceId } } });
  await prisma.message.deleteMany({ where: { conversation: { workspaceId } } });
  await prisma.conversation.deleteMany({ where: { workspaceId } });
  await prisma.contact.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  await prisma.$disconnect();
});

test('a mention puts the chat in that teammate\'s Mentions (only theirs) and notifies only them', async () => {
  const conv = await prisma.conversation.findFirstOrThrow({ where: { workspaceId: ws }, include: { contact: true } });
  const listen = (token: string) =>
    new Promise<{ close: () => void; events: any[] }>((resolve, reject) => {
      const events: any[] = [];
      const s = connectSocket(API, { auth: { token }, transports: ['websocket'] });
      s.on('mention:you', (e) => events.push(e));
      s.on('connect', () => resolve({ close: () => s.close(), events }));
      s.on('connect_error', reject);
    });
  const agentSock = await listen(people.agent.token);
  const supSock = await listen(people.sup.token);
  try {
    for (const p of Object.values(people)) assert.deepEqual((await gql(MENTIONS, {}, p.token)).data.conversations.nodes, []);
    const note = await gql(ADD, { c: conv.contact.id, b: '@Men agent please call back', m: [people.agent.id, people.owner.id] }, people.owner.token);
    assert.equal(note.data?.addContactRemark.body, '@Men agent please call back', JSON.stringify(note.errors));
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual((await gql(MENTIONS, {}, people.agent.token)).data.conversations.nodes.map((c: any) => c.id), [conv.id]);
    assert.deepEqual((await gql(MENTIONS, {}, people.sup.token)).data.conversations.nodes, []); // not mentioned
    assert.deepEqual((await gql(MENTIONS, {}, people.owner.token)).data.conversations.nodes, []); // yourself: ignored
    assert.equal(agentSock.events.length, 1);
    assert.deepEqual(agentSock.events[0], { conversationId: conv.id, actorName: 'Men Owner', contactName: 'Mention Cust', text: '@Men agent please call back' });
    assert.equal(supSock.events.length, 0);
    // a note without mentions changes nothing
    await gql(ADD, { c: conv.contact.id, b: 'plain note' }, people.sup.token);
    assert.deepEqual((await gql(MENTIONS, {}, people.sup.token)).data.conversations.nodes, []);
  } finally {
    agentSock.close();
    supSock.close();
  }
});

test('only teammates of this workspace can be mentioned; the note is refused (not saved) otherwise', async () => {
  const conv = await prisma.conversation.findFirstOrThrow({ where: { workspaceId: ws }, include: { contact: true } });
  const before = await prisma.contactRemark.count({ where: { contactId: conv.contact.id } });
  const r = await gql(ADD, { c: conv.contact.id, b: 'hi @x', m: ['not-a-member-id'] }, people.agent.token);
  assert.equal(r.errors?.[0].extensions?.code, 'BAD_USER_INPUT');
  assert.equal(await prisma.contactRemark.count({ where: { contactId: conv.contact.id } }), before);
});

test('notes are not activity entries in the chat timeline (they show as note bubbles, from chatNotes)', async () => {
  const conv = await prisma.conversation.findFirstOrThrow({ where: { workspaceId: ws } });
  const timeline = (await gql(`query($c: ID!) { conversationActivity(conversationId: $c) { type } }`, { c: conv.id }, people.owner.token)).data?.conversationActivity ?? [];
  assert.ok(!timeline.some((a: any) => a.type === 'remark_added'));
});

test('internal notes in the chat: oldest first, never a message or anything sent to WhatsApp; Clear chat hides older ones for you only', async () => {
  const NOTES = `query($c: ID!) { chatNotes(conversationId: $c) { body authorName } }`;
  const conv = await prisma.conversation.findFirstOrThrow({ where: { workspaceId: ws }, include: { contact: true } });
  const messagesBefore = await prisma.message.count({ where: { conversationId: conv.id } });
  const notes = (await gql(NOTES, { c: conv.id }, people.agent.token)).data.chatNotes;
  assert.deepEqual(notes.map((n: any) => n.body), ['@Men agent please call back', 'plain note']);
  assert.equal(notes[0].authorName, 'Men Owner');
  await gql(ADD, { c: conv.contact.id, b: 'third note' }, people.agent.token);
  assert.equal(await prisma.message.count({ where: { conversationId: conv.id } }), messagesBefore, 'a note is never a message (nothing goes to WhatsApp)');
  // the agent clears the chat: their view starts empty; the owner still sees every note
  await new Promise((r) => setTimeout(r, 20));
  await gql(`mutation($id: ID!) { clearConversation(id: $id) }`, { id: conv.id }, people.agent.token);
  assert.deepEqual((await gql(NOTES, { c: conv.id }, people.agent.token)).data.chatNotes, []);
  assert.equal((await gql(NOTES, { c: conv.id }, people.owner.token)).data.chatNotes.length, 3);
  await gql(ADD, { c: conv.contact.id, b: 'after the clear' }, people.owner.token);
  assert.deepEqual((await gql(NOTES, { c: conv.id }, people.agent.token)).data.chatNotes.map((n: any) => n.body), ['after the clear']);
  // another workspace can't read them
  const other = (await gql(`mutation($i: RegisterInput!) { register(input: $i) { token user { id } workspace { id } } }`, { i: { name: 'Other', email: `e2e-men-x-${run}@example.com`, password: 'password123', workspaceName: `Other ${run}` } })).data.register;
  created.users.push(other.user.id);
  created.workspaces.push(other.workspace.id);
  assert.equal((await gql(NOTES, { c: conv.id }, other.token)).errors?.[0].extensions?.code, 'NOT_FOUND');
});

test('files on notes: uploaded, attached on save (a note may be files only), the team only, never a message; deleting the note removes them', async () => {
  const { existsSync } = await import('node:fs');
  const conv = await prisma.conversation.findFirstOrThrow({ where: { workspaceId: ws }, include: { contact: true } });
  const upload = async (token: string, bytes: Buffer, type: string, name: string, contactId = conv.contact.id) => {
    const r = await fetch(`${API}/inbox/contacts/${contactId}/remark-files?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type }, body: bytes });
    return { status: r.status, body: (await r.json()) as any };
  };
  const download = (token: string, id: string) => fetch(`${API}/inbox/remark-files/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const messagesBefore = await prisma.message.count({ where: { conversationId: conv.id } });

  const a = await upload(people.agent.token, pdf, 'application/pdf', 'quote.pdf');
  const b = await upload(people.agent.token, png, 'image/png', 'tyre.png');
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual([a.body.name, a.body.mime, a.body.size], ['quote.pdf', 'application/pdf', pdf.length]);
  // not a real PDF / not an allowed type: refused
  assert.equal((await upload(people.agent.token, Buffer.from('MZ fake exe'), 'application/pdf', 'x.pdf')).status, 415);
  assert.equal((await upload(people.agent.token, Buffer.from('MZ'), 'application/x-msdownload', 'x.exe')).status, 415);
  // before it's on a note, only the uploader can open it
  assert.equal((await download(people.owner.token, a.body.id)).status, 404);
  // someone else can't attach the agent's uploads to their note
  const stolen = await gql(`mutation($c: ID!, $b: String!, $f: [ID!]) { addContactRemark(contactId: $c, body: $b, files: $f) { id } }`, { c: conv.contact.id, b: 'x', f: [a.body.id] }, people.owner.token);
  assert.equal(stolen.errors?.[0].extensions?.code, 'BAD_USER_INPUT');

  // a note with only files
  const note = await gql(`mutation($c: ID!, $b: String!, $f: [ID!]) { addContactRemark(contactId: $c, body: $b, files: $f) { id body files { id name mime size } } }`, { c: conv.contact.id, b: '', f: [a.body.id, b.body.id] }, people.agent.token);
  assert.equal(note.data?.addContactRemark.body, '', JSON.stringify(note.errors));
  assert.deepEqual(note.data.addContactRemark.files.map((f: any) => f.name), ['quote.pdf', 'tyre.png']);
  // a note with neither text nor files is still refused
  assert.equal((await gql(`mutation($c: ID!, $b: String!) { addContactRemark(contactId: $c, body: $b) { id } }`, { c: conv.contact.id, b: '  ' }, people.agent.token)).errors?.[0].extensions?.code, 'BAD_USER_INPUT');
  // shown in the chat notes, opened by any teammate, byte for byte
  const inChat = (await gql(`query($c: ID!) { chatNotes(conversationId: $c) { id files { name } } }`, { c: conv.id }, people.owner.token)).data.chatNotes;
  assert.ok(inChat.some((n: any) => n.id === note.data.addContactRemark.id && n.files.length === 2));
  const got = await download(people.owner.token, a.body.id);
  assert.equal(got.status, 200);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), pdf);
  assert.match(got.headers.get('content-disposition') ?? '', /quote\.pdf/);
  // another workspace, or no sign-in: no
  const other = (await gql(`mutation($i: RegisterInput!) { register(input: $i) { token user { id } workspace { id } } }`, { i: { name: 'Other2', email: `e2e-men-y-${run}@example.com`, password: 'password123', workspaceName: `Other2 ${run}` } })).data.register;
  created.users.push(other.user.id);
  created.workspaces.push(other.workspace.id);
  assert.equal((await download(other.token, a.body.id)).status, 404);
  assert.equal((await fetch(`${API}/inbox/remark-files/${a.body.id}`)).status, 401);
  assert.equal(await prisma.message.count({ where: { conversationId: conv.id } }), messagesBefore, 'never a message');
  // deleting the note removes its files (rows and the files on disk)
  const stored = await prisma.remarkFile.findMany({ where: { remarkId: note.data.addContactRemark.id } });
  assert.ok(stored.every((f) => existsSync(path.join(env.uploadsDir, f.path))));
  await gql(`mutation($id: ID!) { deleteContactRemark(id: $id) }`, { id: note.data.addContactRemark.id }, people.agent.token);
  assert.equal(await prisma.remarkFile.count({ where: { id: { in: stored.map((f) => f.id) } } }), 0);
  assert.ok(stored.every((f) => !existsSync(path.join(env.uploadsDir, f.path))));
});

describe('mentions: bell while offline, deleted and edited notes, agents on New Leads', () => {
  const FEED = `{ notifications { unseen items { type actorName contactName data } } }`;
  const bellMentions = async (token: string) => (await gql(FEED, {}, token)).data.notifications.items.filter((i: any) => i.type === 'note_mention').map((i: any) => JSON.parse(i.data));
  const mentionsList = async (token: string) => (await gql(MENTIONS, {}, token)).data.conversations.nodes.map((c: any) => c.id);
  let conv: { id: string; contactId: string };
  before(async () => {
    await gql(`mutation($i: SimulateIncomingInput) { simulateIncomingMessage(input: $i) }`, { i: { waId: `9715${String(run + 7).slice(-8)}`, name: 'Second Cust', body: 'hello' } }, people.owner.token);
    const c = await prisma.conversation.findFirstOrThrow({ where: { workspaceId: ws, contact: { name: 'Second Cust' } } });
    conv = { id: c.id, contactId: c.contactId };
  });

  test("a mention stays in the mentioned person's 🔔 (seen after being offline); nobody else's, not even an admin's", async () => {
    // the supervisor isn't connected at all
    const r = await gql(ADD, { c: conv.contactId, b: '@Men sup can you check stock?', m: [people.sup.id] }, people.agent.token);
    assert.ok(r.data?.addContactRemark.id, JSON.stringify(r.errors));
    const sup = await bellMentions(people.sup.token);
    assert.equal(sup.length, 1);
    assert.equal(sup[0].text, '@Men sup can you check stock?');
    assert.equal(sup[0].mentionedUserId, people.sup.id);
    assert.ok((await gql(FEED, {}, people.sup.token)).data.notifications.unseen >= 1);
    assert.deepEqual(await bellMentions(people.owner.token), []); // admin: not their mention
    assert.deepEqual(await mentionsList(people.sup.token), [conv.id]);
    // never in the chat timeline or the contact's activity log
    const timeline = (await gql(`query($c: ID!) { conversationActivity(conversationId: $c) { type } }`, { c: conv.id }, people.owner.token)).data.conversationActivity;
    assert.ok(!timeline.some((a: any) => a.type === 'note_mention'));
    const contactLog = (await gql(`query($c: ID!) { contactActivity(contactId: $c) { type } }`, { c: conv.contactId }, people.owner.token)).data?.contactActivity ?? [];
    assert.ok(!contactLog.some((a: any) => a.type === 'note_mention'));
  });

  test('editing a note moves its mentions: a removed @Name loses it, a new one gets it (and is told), no duplicates', async () => {
    const note = (await gql(`query($c: ID!) { chatNotes(conversationId: $c) { id body } }`, { c: conv.id }, people.owner.token)).data.chatNotes.find((n: any) => n.body.startsWith('@Men sup'));
    const events: any[] = [];
    const s = connectSocket(API, { auth: { token: people.owner.token }, transports: ['websocket'] });
    s.on('mention:you', (e) => events.push(e));
    await new Promise<void>((r) => s.on('connect', () => r()));
    try {
      const upd = await gql(`mutation($id: ID!, $b: String!) { updateContactRemark(id: $id, body: $b) { id } }`, { id: note.id, b: '@Men Owner can you check stock?' }, people.agent.token);
      assert.ok(upd.data?.updateContactRemark.id, JSON.stringify(upd.errors));
      await new Promise((r) => setTimeout(r, 400));
      assert.deepEqual(await bellMentions(people.sup.token), []); // removed
      assert.deepEqual(await mentionsList(people.sup.token), []);
      assert.equal((await bellMentions(people.owner.token)).length, 1); // added
      assert.deepEqual(await mentionsList(people.owner.token), [conv.id]);
      assert.equal(events.length, 1);
      assert.equal(events[0].text, '@Men Owner can you check stock?');
      // same @Name, new text: still one mention, with the new text; nobody told again
      await gql(`mutation($id: ID!, $b: String!) { updateContactRemark(id: $id, body: $b) { id } }`, { id: note.id, b: '@Men Owner please check stock today' }, people.agent.token);
      await new Promise((r) => setTimeout(r, 300));
      const owner = await bellMentions(people.owner.token);
      assert.equal(owner.length, 1);
      assert.equal(owner[0].text, '@Men Owner please check stock today');
      assert.equal(events.length, 1);
    } finally {
      s.close();
    }
  });

  test('deleting a note takes it off the Mentions list and out of the bell', async () => {
    const note = (await gql(`query($c: ID!) { chatNotes(conversationId: $c) { id body } }`, { c: conv.id }, people.owner.token)).data.chatNotes.find((n: any) => n.body.startsWith('@Men Owner'));
    const changed: any[] = [];
    const s = connectSocket(API, { auth: { token: people.owner.token }, transports: ['websocket'] });
    s.on('mentions:changed', (e) => changed.push(e));
    await new Promise<void>((r) => s.on('connect', () => r()));
    try {
      await gql(`mutation($id: ID!) { deleteContactRemark(id: $id) }`, { id: note.id }, people.agent.token);
      await new Promise((r) => setTimeout(r, 400));
      assert.deepEqual(await mentionsList(people.owner.token), []);
      assert.deepEqual(await bellMentions(people.owner.token), []);
      assert.equal(changed.length, 1, 'their screen is told to reload');
    } finally {
      s.close();
    }
  });

  test('an agent can add a note on an unassigned New Lead (replying still needs Assign to Me)', async () => {
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } })).assignedToId, null);
    const note = await gql(ADD, { c: conv.contactId, b: 'Called, no answer' }, people.agent.token);
    assert.ok(note.data?.addContactRemark.id, JSON.stringify(note.errors));
    const reply = await gql(`mutation($i: SendTextInput!) { sendTextMessage(input: $i) { id } }`, { i: { conversationId: conv.id, body: 'hi' } }, people.agent.token);
    assert.ok(reply.errors?.[0], 'still refused');
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } })).assignedToId, null, 'a note does not assign the chat');
  });
});
