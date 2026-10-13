import { gql } from './api';

// Who a chat is assigned to: a workspace member, in the "assignee" shape the UI uses. `id` is the member id,
// `userId` the person's user id ("Assigned to me", notifications), `color` their role colour.
export type Assignee = { id: string; name: string; color: string; conversationCount: number; userId: string | null };
type AssigneeRef = Pick<Assignee, 'id' | 'name' | 'color' | 'userId'>;
export type WorkspaceMember = { id: string; name: string; email: string; role: string };

const FIELDS = 'id name color conversationCount userId';

// Every active member, with how many chats they hold
export async function fetchAssignees() {
  return (await gql<{ assignees: Assignee[] }>(`query Assignees { assignees { ${FIELDS} } }`)).assignees;
}

export async function fetchWorkspaceMembers() {
  return (await gql<{ workspaceMembers: WorkspaceMember[] }>(`query Members { workspaceMembers { id name email role } }`))
    .workspaceMembers;
}

// "Assign to Me" on a New Lead: take an unassigned chat for yourself (fails if someone else got it first)
export async function claimConversation(conversationId: string) {
  const query = `mutation Claim($c: ID!) { claimConversation(conversationId: $c) { id assignee { id name color userId } } }`;
  return (await gql<{ claimConversation: { id: string; assignee: AssigneeRef | null } }>(query, { c: conversationId })).claimConversation;
}

// assigneeId: the member id (null to unassign). memberId (instead): the person's user id.
export async function assignConversation(conversationId: string, assigneeId: string | null, memberId?: string) {
  const query = `mutation Assign($c: ID!, $a: ID, $m: ID) { assignConversation(conversationId: $c, assigneeId: $a, memberId: $m) { id assignee { id name color userId } } }`;
  return (
    await gql<{ assignConversation: { id: string; assignee: AssigneeRef | null } }>(query, { c: conversationId, a: assigneeId, m: memberId ?? null })
  ).assignConversation;
}
