import { gql } from './api';

// Who a chat is assigned to: a name + colour managed like labels, one per chat
export type Assignee = { id: string; name: string; color: string; conversationCount: number };
type AssigneeRef = Pick<Assignee, 'id' | 'name' | 'color'>;

const FIELDS = 'id name color conversationCount';

export async function fetchAssignees() {
  return (await gql<{ assignees: Assignee[] }>(`query Assignees { assignees { ${FIELDS} } }`)).assignees;
}

export async function createAssignee(input: { name: string; color: string }) {
  const query = `mutation CreateAssignee($input: CreateAssigneeInput!) { createAssignee(input: $input) { ${FIELDS} } }`;
  return (await gql<{ createAssignee: Assignee }>(query, { input })).createAssignee;
}

export async function updateAssignee(id: string, input: { name?: string; color?: string }) {
  const query = `mutation UpdateAssignee($id: ID!, $input: UpdateAssigneeInput!) { updateAssignee(id: $id, input: $input) { ${FIELDS} } }`;
  return (await gql<{ updateAssignee: Assignee }>(query, { id, input })).updateAssignee;
}

export async function deleteAssignee(id: string) {
  await gql(`mutation DeleteAssignee($id: ID!) { deleteAssignee(id: $id) }`, { id });
}

// Pass assigneeId null to unassign
export async function assignConversation(conversationId: string, assigneeId: string | null) {
  const query = `mutation Assign($c: ID!, $a: ID) { assignConversation(conversationId: $c, assigneeId: $a) { id assignee { id name color } } }`;
  return (await gql<{ assignConversation: { id: string; assignee: AssigneeRef | null } }>(query, { c: conversationId, a: assigneeId }))
    .assignConversation;
}
