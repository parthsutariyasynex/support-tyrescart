// Settings → Workspace preferences (admins) and the Lead source / Priority choices per workspace. Defaults are the
// values the app had before, so nothing changes until an admin edits them. Needs the server running (API_URL).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prisma } from '../src/prisma.js';

const API = process.env.API_URL ?? 'http://localhost:5001';
const run = Date.now();
async function gql(query: string, variables: object = {}, token?: string) {
  const res = await fetch(`${API}/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  const j = (await res.json()) as { data?: any; errors?: { message: string }[] };
  if (j.errors) throw new Error(j.errors[0].message);
  return j.data;
}
const REG = `mutation($i: RegisterInput!) { register(input: $i) { token user { id } workspace { id } } }`;
const F = 'defaultTimeZone defaultCountry businessDayStartHour reminderMinutes awayMinutes deletedContactRetentionDays';
const SET = `mutation($i: WorkspaceSettingsInput!) { updateWorkspaceSettings(input: $i) { ${F} } }`;

test('workspace preferences: defaults, admins only, validated, in "me", applied', async () => {
  const o = (await gql(REG, { i: { name: 'Owner', email: `e2e-ws-o-${run}@example.com`, password: 'password123', workspaceName: `ws-${run}` } })).register;
  const { token: join } = (await gql(`mutation { createJoinLink { token } }`, {}, o.token)).createJoinLink;
  const a = (await gql(REG, { i: { name: 'Agent', email: `e2e-ws-a-${run}@example.com`, password: 'password123', joinToken: join } })).register;
  const s0 = (await gql(`{ workspaceSettings { ${F} } }`, {}, a.token)).workspaceSettings;
  assert.equal(s0.defaultTimeZone, 'Asia/Dubai');
  assert.equal(s0.defaultCountry, 'AE');
  assert.equal(s0.businessDayStartHour, 9);
  assert.equal(s0.deletedContactRetentionDays, 14);
  await assert.rejects(gql(SET, { i: { defaultCountry: 'IN' } }, a.token), /admins/i);
  await assert.rejects(gql(SET, { i: { defaultTimeZone: 'Mars/Base' } }, o.token), /time zone/i);
  // every time is shown in Dubai time: another zone can't be chosen, and one saved earlier isn't used
  await assert.rejects(gql(SET, { i: { defaultTimeZone: 'Asia/Kolkata' } }, o.token), /Dubai time/);
  await prisma.workspaceSettings.upsert({ where: { workspaceId: o.workspace.id }, update: { defaultTimeZone: 'Asia/Kolkata' }, create: { workspaceId: o.workspace.id, defaultTimeZone: 'Asia/Kolkata' } });
  await assert.rejects(gql(SET, { i: { businessDayStartHour: 24 } }, o.token), /hour/i);
  await assert.rejects(gql(SET, { i: { deletedContactRetentionDays: 0 } }, o.token), /1 day/i);
  const s1 = (await gql(SET, { i: { defaultTimeZone: 'Asia/Dubai', defaultCountry: 'in', businessDayStartHour: 10, deletedContactRetentionDays: 30, reminderMinutes: 0 } }, o.token)).updateWorkspaceSettings;
  assert.deepEqual([s1.defaultTimeZone, s1.defaultCountry, s1.businessDayStartHour, s1.deletedContactRetentionDays, s1.reminderMinutes], ['Asia/Dubai', 'IN', 10, 30, 0]);
  assert.equal(s1.awayMinutes, s0.awayMinutes); // untouched: still the default
  const me = (await gql(`{ me { workspace { settings { defaultTimeZone defaultCountry businessDayStartHour } } } }`, {}, a.token)).me;
  assert.deepEqual(me.workspace.settings, { defaultTimeZone: 'Asia/Dubai', defaultCountry: 'IN', businessDayStartHour: 10 });

  // retention: a deleted contact is kept for the workspace's days
  await gql(`mutation($i: SimulateIncomingInput) { simulateIncomingMessage(input: $i) }`, { i: { waId: '971505557001', name: 'Ret', body: 'hi' } }, o.token);
  const cid = (await prisma.contact.findFirstOrThrow({ where: { workspaceId: o.workspace.id, waId: '971505557001' } })).id;
  // reminders off for this workspace: an unanswered chat isn't reminded, however long it waits
  const remind = async () =>
    (await (await fetch(`${API}/inbox/dev/assignment-reminders`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.token}` }, body: JSON.stringify({ now: new Date(Date.now() + 3 * 3600_000).toISOString() }) })).json()).reminded;
  assert.equal(await remind(), 0);
  await gql(SET, { i: { reminderMinutes: 5 } }, o.token);
  assert.ok((await remind()) >= 1);

  await gql(`mutation($id: ID!) { deleteContact(id: $id) }`, { id: cid }, o.token);
  const d = (await gql(`{ deletedContacts { deletedAt purgeAt } deletedContactsRetentionDays }`, {}, o.token));
  assert.equal(d.deletedContactsRetentionDays, 30);
  assert.equal(new Date(d.deletedContacts[0].purgeAt).getTime() - new Date(d.deletedContacts[0].deletedAt).getTime(), 30 * 86_400_000);
  await gql(`mutation($id: ID!) { restoreContact(id: $id) }`, { id: cid }, o.token);
});

test('Lead source and Priority choices: per workspace, rename keeps contacts, remove clears them', async () => {
  const o = (await gql(REG, { i: { name: 'Owner', email: `e2e-ch-o-${run}@example.com`, password: 'password123', workspaceName: `ch-${run}` } })).register;
  const { token: join } = (await gql(`mutation { createJoinLink { token } }`, {}, o.token)).createJoinLink;
  const a = (await gql(REG, { i: { name: 'Agent', email: `e2e-ch-a-${run}@example.com`, password: 'password123', joinToken: join } })).register;
  const opts = async () => (await gql(`{ contactFieldOptions { leadSources { value label } priorities { value label } } }`, {}, a.token)).contactFieldOptions;
  const o0 = await opts();
  assert.deepEqual(o0.priorities.map((p: any) => p.value), ['low', 'medium', 'high', 'urgent']);
  assert.ok(o0.leadSources.some((s: any) => s.value === 'walk_in' && s.label === 'Walk-in'));
  await gql(`mutation($i: SimulateIncomingInput) { simulateIncomingMessage(input: $i) }`, { i: { waId: '971505557002', name: 'Ch', body: 'hi' } }, o.token);
  const cid = (await prisma.contact.findFirstOrThrow({ where: { workspaceId: o.workspace.id, waId: '971505557002' } })).id;
  const UPD = `mutation($id: ID!, $i: ContactInput!) { updateContact(id: $id, input: $i) { leadSource priority } }`;
  await gql(UPD, { id: cid, i: { leadSource: 'walk_in', priority: 'urgent' } }, a.token);
  const SAVE = `mutation($f: String!, $c: [FieldChoiceInput!]!) { saveFieldChoices(field: $f, choices: $c) { cleared choices { value label } } }`;
  await assert.rejects(gql(SAVE, { f: 'priority', c: [{ label: 'X' }] }, a.token), /admins/i);
  await assert.rejects(gql(SAVE, { f: 'priority', c: [{ label: 'A' }, { label: 'a' }] }, o.token), /same name/i);
  await assert.rejects(gql(SAVE, { f: 'priority', c: [] }, o.token), /at least one/i);
  // rename Walk-in → Garage visit (same value), add Instagram, remove Other
  const sources = o0.leadSources.filter((s: any) => s.value !== 'other').map((s: any) => (s.value === 'walk_in' ? { value: s.value, label: 'Garage visit' } : s));
  const r1 = (await gql(SAVE, { f: 'leadSource', c: [...sources, { label: 'Instagram' }] }, o.token)).saveFieldChoices;
  assert.equal(r1.cleared, 0);
  assert.ok(r1.choices.some((c: any) => c.value === 'walk_in' && c.label === 'Garage visit'));
  const insta = r1.choices.find((c: any) => c.label === 'Instagram');
  assert.ok(insta.value.length <= 10);
  assert.equal((await prisma.contact.findUniqueOrThrow({ where: { id: cid } })).leadSource, 'walk_in'); // kept
  await gql(UPD, { id: cid, i: { leadSource: insta.value } }, a.token);
  await assert.rejects(gql(UPD, { id: cid, i: { leadSource: 'other' } }, a.token), /valid lead source/i); // removed
  // priorities: remove Urgent (its contact is cleared), add Critical
  const counts = (await gql(`{ fieldChoiceCounts(field: "priority") { value count } }`, {}, o.token)).fieldChoiceCounts;
  assert.ok(counts.some((c: any) => c.value === 'urgent' && c.count === 1));
  const r2 = (await gql(SAVE, { f: 'priority', c: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }, { label: 'Critical' }] }, o.token)).saveFieldChoices;
  assert.equal(r2.cleared, 1);
  assert.equal((await prisma.contact.findUniqueOrThrow({ where: { id: cid } })).priority, null);
  const critical = r2.choices.find((c: any) => c.label === 'Critical').value;
  const saved = (await gql(UPD, { id: cid, i: { priority: critical } }, a.token)).updateContact;
  assert.equal(saved.priority, critical);
  // the activity log shows the names
  const log = (await gql(`query($c: ID!) { contactActivity(contactId: $c) { type data } }`, { c: cid }, o.token)).contactActivity;
  assert.ok(JSON.stringify(log).includes('Critical') && JSON.stringify(log).includes('Instagram'));
  // another workspace still has the standard lists
  const other = (await gql(REG, { i: { name: 'X', email: `e2e-ch-x-${run}@example.com`, password: 'password123', workspaceName: `chx-${run}` } })).register;
  const ox = (await gql(`{ contactFieldOptions { priorities { value } } }`, {}, other.token)).contactFieldOptions;
  assert.deepEqual(ox.priorities.map((p: any) => p.value), ['low', 'medium', 'high', 'urgent']);
  await prisma.$disconnect();
});
