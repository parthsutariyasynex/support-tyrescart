import { gql } from './api';

// WhatsApp Business-style quick replies: typing "/" in the message box offers these
export type QuickReply = { id: string; shortcut: string; description: string | null; category: string | null };

// Up to 100 (the API maximum), so "/" alone lists every reply a workspace normally has
export async function fetchQuickReplies(search: string) {
  const query = `query QuickReplies($s: String) { quickReplies(search: $s, first: 100) { id shortcut description category } }`;
  return (await gql<{ quickReplies: QuickReply[] }>(query, { s: search || null })).quickReplies;
}

// Settings → Saved replies: the list plus who added / last edited each one (names are null for imported replies)
export type SavedReply = QuickReply & {
  sortOrder: number;
  createdAt: string | null;
  createdByName: string | null;
  updatedAt: string | null;
  updatedByName: string | null;
};
const SAVED_FIELDS = 'id shortcut description category sortOrder createdAt createdByName updatedAt updatedByName';

export async function fetchSavedReplies(search: string) {
  const query = `query SavedReplies($s: String) { quickReplies(search: $s, first: 100) { ${SAVED_FIELDS} } }`;
  return (await gql<{ quickReplies: SavedReply[] }>(query, { s: search || null })).quickReplies;
}

export type QuickReplyInput = { shortcut: string; description: string; category: string };

export async function createQuickReply(input: QuickReplyInput) {
  const query = `mutation CreateQuickReply($input: CreateQuickReplyInput!) { createQuickReply(input: $input) { ${SAVED_FIELDS} } }`;
  return (await gql<{ createQuickReply: SavedReply }>(query, { input })).createQuickReply;
}

// An empty category clears it
export async function updateQuickReply(id: string, input: Partial<QuickReplyInput>) {
  const query = `mutation UpdateQuickReply($id: ID!, $input: UpdateQuickReplyInput!) { updateQuickReply(id: $id, input: $input) { ${SAVED_FIELDS} } }`;
  return (await gql<{ updateQuickReply: SavedReply }>(query, { id, input })).updateQuickReply;
}

export async function deleteQuickReply(id: string) {
  const query = `mutation DeleteQuickReply($id: ID!) { deleteQuickReply(id: $id) }`;
  return (await gql<{ deleteQuickReply: string }>(query, { id })).deleteQuickReply;
}

// Adding, editing and deleting saved replies: owners, admins and supervisors (the server checks the same)
export const canManageQuickReplies = (role?: string | null) => role === 'owner' || role === 'admin' || role === 'supervisor';

// Same rule as the server (case-insensitive partial match on shortcut, text or category), used to narrow
// results that are still loading so the menu never offers a reply that doesn't match what's typed
export function matchesQuickReply(reply: QuickReply, search: string) {
  const t = search.trim().toLowerCase();
  if (!t) return true;
  // Categories are shown with spaces ("car tyres") but stored with underscores ("car_tyres")
  const category = reply.category?.toLowerCase().replace(/_/g, ' ');
  return [reply.shortcut, reply.description].some((v) => !!v && v.toLowerCase().includes(t)) || !!category?.includes(t.replace(/_/g, ' '));
}

// The message box opens the menu when it starts with "/"; the rest is the search ("/tyrescart" -> "tyrescart")
export function slashQuery(text: string): string | null {
  return text.startsWith('/') ? text.slice(1) : null;
}

// Splits text into parts, marking each case-insensitive occurrence of `query` (for highlighting)
export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  const q = query.trim();
  if (!q) return [{ text, match: false }];
  const parts: { text: string; match: boolean }[] = [];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push({ text: text.slice(from, at), match: false });
    parts.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false });
  return parts;
}
