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

// Names for the palette colours (Settings → Labels colour filter); any other colour is "Custom"
const COLOR_NAMES: Record<string, string> = {
  '#25d366': 'Green',
  '#128c7e': 'Teal',
  '#34b7f1': 'Blue',
  '#5e5ce6': 'Indigo',
  '#a259ff': 'Purple',
  '#ff6fb5': 'Pink',
  '#ff3b30': 'Red',
  '#ff9500': 'Orange',
  '#ffcc00': 'Yellow',
  '#8e8e93': 'Grey',
};
export const colorName = (color: string) => COLOR_NAMES[color.toLowerCase()] ?? `Custom (${color.toLowerCase()})`;

// Settings → Labels list: search by name, filter by colour ('' = all), sort by name; then one page of it
export function filterLabels<L extends Pick<Label, 'name' | 'color'>>(labels: L[], query: string, color: string, sort: 'asc' | 'desc') {
  const q = query.trim().toLowerCase();
  return labels
    .filter((l) => (!q || l.name.toLowerCase().includes(q)) && (!color || l.color.toLowerCase() === color.toLowerCase()))
    .sort((a, b) => (sort === 'asc' ? 1 : -1) * a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}
export function pageOf<T>(items: T[], page: number, size: number) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, page), pages);
  return { items: items.slice((current - 1) * size, current * size), page: current, pages };
}
// The colours the labels use, in palette order, then any custom ones
export function usedColors(labels: Pick<Label, 'color'>[]) {
  const used = [...new Set(labels.map((l) => l.color.toLowerCase()))];
  return [...LABEL_COLORS.filter((c) => used.includes(c)), ...used.filter((c) => !(LABEL_COLORS as readonly string[]).includes(c))];
}

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
// canManageAssignments: assign/reassign/unassign chats and see the Assign checkboxes. Open to every role, so the
// server returns true for every member. The server decides; the client only shows or hides controls.
export type Permissions = { userId: string; role: string; canManageLabels: boolean; canManageAssignments: boolean };

export async function fetchPermissions(): Promise<Permissions> {
  const { me } = await gql<{ me: { user: { id: string }; role: string; canManageLabels: boolean; canManageAssignments: boolean } }>(
    `query Permissions { me { user { id } role canManageLabels canManageAssignments } }`,
  );
  return { userId: me.user.id, role: me.role, canManageLabels: me.canManageLabels, canManageAssignments: me.canManageAssignments };
}
