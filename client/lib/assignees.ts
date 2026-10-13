import { gql } from './api';

// Who a chat is assigned to: a name + colour managed like labels, one per chat.
// `userId` links it to a workspace member ("Assigned to me", assignment notifications); null = just a name.
export type Assignee = { id: string; name: string; color: string; conversationCount: number; userId: string | null };
type AssigneeRef = Pick<Assignee, 'id' | 'name' | 'color' | 'userId'>;
export type WorkspaceMember = { id: string; name: string; email: string; role: string };

const FIELDS = 'id name color conversationCount userId';

export async function fetchAssignees() {
  return (await gql<{ assignees: Assignee[] }>(`query Assignees { assignees { ${FIELDS} } }`)).assignees;
}

export async function fetchWorkspaceMembers() {
  return (await gql<{ workspaceMembers: WorkspaceMember[] }>(`query Members { workspaceMembers { id name email role } }`))
    .workspaceMembers;
}

export async function createAssignee(input: { name: string; color: string; userId?: string | null }) {
  const query = `mutation CreateAssignee($input: CreateAssigneeInput!) { createAssignee(input: $input) { ${FIELDS} } }`;
  return (await gql<{ createAssignee: Assignee }>(query, { input })).createAssignee;
}

// userId: null unlinks; leave it out to keep the current link
export async function updateAssignee(id: string, input: { name?: string; color?: string; userId?: string | null }) {
  const query = `mutation UpdateAssignee($id: ID!, $input: UpdateAssigneeInput!) { updateAssignee(id: $id, input: $input) { ${FIELDS} } }`;
  return (await gql<{ updateAssignee: Assignee }>(query, { id, input })).updateAssignee;
}

export async function deleteAssignee(id: string) {
  await gql(`mutation DeleteAssignee($id: ID!) { deleteAssignee(id: $id) }`, { id });
}

// "Assign to Me" on a New Lead: take an unassigned chat for yourself (fails if someone else got it first)
export async function claimConversation(conversationId: string) {
  const query = `mutation Claim($c: ID!) { claimConversation(conversationId: $c) { id assignee { id name color userId } } }`;
  return (await gql<{ claimConversation: { id: string; assignee: AssigneeRef | null } }>(query, { c: conversationId })).claimConversation;
}

// Pass assigneeId null to unassign. memberId (instead): assign to that Supervisor or Agent; the server uses
// the assignee linked to them, creating it the first time.
export async function assignConversation(conversationId: string, assigneeId: string | null, memberId?: string) {
  const query = `mutation Assign($c: ID!, $a: ID, $m: ID) { assignConversation(conversationId: $c, assigneeId: $a, memberId: $m) { id assignee { id name color userId } } }`;
  return (
    await gql<{ assignConversation: { id: string; assignee: AssigneeRef | null } }>(query, { c: conversationId, a: assigneeId, m: memberId ?? null })
  ).assignConversation;
}
