import { gql } from './api';

export type Label = { id: string; name: string; color: string; conversationCount: number };

// Colour choices offered in the label editor (any #rrggbb is accepted by the API)
export const LABEL_COLORS = [
  '#25d366',
  '#128c7e',
  '#34b7f1',
  '#5e5ce6',
  '#a259ff',
  '#ff6fb5',
  '#ff3b30',
  '#ff9500',
  '#ffcc00',
  '#8e8e93',
];

const LABEL_FIELDS = 'id name color conversationCount';

export async function fetchLabels() {
  return (await gql<{ labels: Label[] }>(`query Labels { labels { ${LABEL_FIELDS} } }`)).labels;
}

export async function createLabel(input: { name: string; color: string }) {
  const query = `mutation CreateLabel($input: CreateLabelInput!) { createLabel(input: $input) { ${LABEL_FIELDS} } }`;
  return (await gql<{ createLabel: Label }>(query, { input })).createLabel;
}

export async function updateLabel(id: string, input: { name?: string; color?: string }) {
  const query = `mutation UpdateLabel($id: ID!, $input: UpdateLabelInput!) { updateLabel(id: $id, input: $input) { ${LABEL_FIELDS} } }`;
  return (await gql<{ updateLabel: Label }>(query, { id, input })).updateLabel;
}

export async function deleteLabel(id: string) {
  await gql(`mutation DeleteLabel($id: ID!) { deleteLabel(id: $id) }`, { id });
}

type ConversationLabels = { id: string; labels: Pick<Label, 'id' | 'name' | 'color'>[] };

export async function addConversationLabel(conversationId: string, labelId: string) {
  const query = `mutation AddLabel($c: ID!, $l: ID!) { addConversationLabel(conversationId: $c, labelId: $l) { id labels { id name color } } }`;
  return (await gql<{ addConversationLabel: ConversationLabels }>(query, { c: conversationId, l: labelId }))
    .addConversationLabel;
}

export async function removeConversationLabel(conversationId: string, labelId: string) {
  const query = `mutation RemoveLabel($c: ID!, $l: ID!) { removeConversationLabel(conversationId: $c, labelId: $l) { id labels { id name color } } }`;
  return (await gql<{ removeConversationLabel: ConversationLabels }>(query, { c: conversationId, l: labelId }))
    .removeConversationLabel;
}

// Owners and admins can always manage labels and assignees; agents only when granted
export type Permissions = { userId: string; role: string; canManageLabels: boolean };

export async function fetchPermissions(): Promise<Permissions> {
  const { me } = await gql<{ me: { user: { id: string }; role: string; canManageLabels: boolean } }>(
    `query Permissions { me { user { id } role canManageLabels } }`,
  );
  return { userId: me.user.id, role: me.role, canManageLabels: me.canManageLabels };
}
