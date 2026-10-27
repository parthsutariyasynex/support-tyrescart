// Left menu → Lifecycle stages: "New (3)". Each count is the number of chats the stage link lists in the Inbox
// (contacts with a chat at that stage, deleted contacts left out); without `chats` the query still counts every
// contact (Settings → Customer lifecycle). Uses the running API (API_URL).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { prisma } from '../src/prisma.js';

const API = process.env.API_URL ?? 'http://localhost:5001';
const run = Date.now();
async function gql(query: string, variables: object = {}, token?: string) {
  const res = await fetch(`${API}/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  const j = (await res.json()) as { data?: any; errors?: { message: string }[] };
  if (j.errors) throw new Error(j.errors[0].message);
  return j.data;
}
after(() => prisma.$disconnect());

test('stage counts in the left menu match what each stage link lists; settings counts unchanged', async () => {
  const reg = `mutation($i: RegisterInput!) { register(input: $i) { token workspace { id } } }`;
  const o = (await gql(reg, { i: { name: `Owner ${run}`, email: `e2e-sc-o-${run}@example.com`, password: 'password123', workspaceName: `Stage counts ${run}` } })).register;
  const ws = o.workspace.id;
  const stages: string[] = (await gql(`{ contactFieldOptions { leadStages { value } } }`, {}, o.token)).contactFieldOptions.leadStages.map((s: { value: string }) => s.value);
  const [first, second] = stages;

  // four customers write (they start on the workspace's default stage); one more contact has no chat
  for (let i = 0; i < 4; i++)
    await gql(`mutation($i: SimulateIncomingInput) { simulateIncomingMessage(input: $i) }`, { i: { waId: `9715${String(run).slice(-7)}${i}`, name: `Stage ${run.toString(36)} ${i}`, body: 'Hi' } }, o.token);
  await prisma.contact.create({ data: { workspaceId: ws, waId: `9716${String(run).slice(-7)}9`, name: 'No chat yet', leadStage: second } });
  const contacts = await prisma.contact.findMany({ where: { workspaceId: ws, conversations: { some: {} } }, orderBy: { waId: 'asc' } });
  const defaultStage = contacts[0].leadStage!;
  const other = defaultStage === first ? second : first;

  // move one chat to another stage (as the profile panel does), delete another contact
  // (a direct soft delete, not the deleteContact mutation, so it can be restored below: deleteContact now removes
  // the contact outright)
  await gql(`mutation($id: ID!, $i: ContactInput!) { updateContact(id: $id, input: $i) { id } }`, { id: contacts[1].id, i: { leadStage: other } }, o.token);
  await prisma.contact.update({ where: { id: contacts[2].id }, data: { deletedAt: new Date() } });

  const counts = async (chats?: boolean) =>
    Object.fromEntries(
      ((await gql(`query($c: Boolean) { leadStageCounts(chats: $c) { stage count } }`, { c: chats ?? null }, o.token)).leadStageCounts as { stage: string | null; count: number }[]).map((r) => [r.stage, r.count]),
    );
  const listed = async (stage: string) => (await gql(`query($s: String) { conversations(leadStage: $s, first: 100) { nodes { id } } }`, { s: stage }, o.token)).conversations.nodes.length;

  const menu = await counts(true);
  assert.equal(menu[defaultStage], 2); // 4 chats - 1 moved - 1 deleted
  assert.equal(menu[other], 1);
  for (const s of stages) assert.equal(menu[s] ?? 0, await listed(s), `stage ${s}: the count matches the stage link`);

  // Settings → Customer lifecycle still counts every contact (deleted ones and ones without a chat too)
  const all = await counts();
  assert.equal(all[defaultStage], 3);
  assert.equal(all[other] ?? 0, 1 + (other === second ? 1 : 0));

  // restoring the deleted contact brings its chat back into the count
  await gql(`mutation($id: ID!) { restoreContact(id: $id) }`, { id: contacts[2].id }, o.token);
  assert.equal((await counts(true))[defaultStage], 3);
});
