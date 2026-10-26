import { gql } from './api';
import type { Assignee } from './assignees';
import type { Label } from './labels';

export type Contact = { id: string; waId: string; name: string | null; leadStage?: string | null; country?: string | null };
export type Message = {
  id: string;
  conversationId: string;
  direction: 'in' | 'out';
  type: string;
  body: string;
  status: string;
  error?: string | null;
  createdAt: string;
  // Agent who sent an outgoing message (null for customer messages and older ones)
  sentById: string | null;
  // Worked out by the server: agent's name, or the customer's name/number; null for older agent messages
  senderName: string | null;
  editedAt: string | null;
  // Deleted for everyone: body is empty
  deletedAt: string | null;
  // Bumped on every edit/delete; newer versions win over late socket events
  version: number;
  // Images sent from the app: image/jpeg or image/png (file at /inbox/messages/{id}/media); null otherwise
  mediaMime?: string | null;
  mediaSize?: number | null;
  // Documents: the file name
  mediaName?: string | null;
  // Reactions, as in WhatsApp: the customer's and the business's (one for the whole team), as emojis
  customerReaction?: string | null;
  teamReaction?: string | null;
  teamReactionById?: string | null;
  // Sent by Simple automations (e.g. 'auto_reply') rather than a person
  automation?: string | null;
  // A reply, as in WhatsApp: the message it quotes
  replyToId?: string | null;
  replyTo?: QuotedMessage | null;
};
export type QuotedMessage = {
  id: string;
  direction: 'in' | 'out';
  type: string;
  body: string; // empty once deleted
  senderName: string | null;
  deleted: boolean;
  mediaMime?: string | null;
  mediaName?: string | null;
};
export type Conversation = {
  id: string;
  contact: Contact;
  unread: number;
  lastMessageAt: string;
  lastInboundAt: string | null;
  lastMessage: Message | null;
  labels: Pick<Label, 'id' | 'name' | 'color'>[];
  assignee: Pick<Assignee, 'id' | 'name' | 'color' | 'userId'> | null;
  // When the current assignee first opened the chat after it was assigned to them; null = not yet
  assigneeOpenedAt: string | null;
  // Closed chats keep everything; new customer messages don't reopen them
  status: ConversationStatus;
  closedAt: string | null;
  closedById: string | null;
  // status = snoozed: back to open at this time (or when the customer writes)
  snoozedUntil: string | null;
  // Pinned to the top of your own list
  pinned: boolean;
  // You are a collaborator on it (shows in Collaborations)
  isCollaborator: boolean;
  // Was ever assigned to someone: then it's no longer a New Lead, even if unassigned again
  wasAssigned?: boolean;
};

// New Leads: open chats nobody holds right now (the server applies the same rule with assignee 'new_leads'). An
// unassigned chat comes back here at once; closed and snoozed chats stay in the Inbox only.
export const isNewLead = (c: Pick<Conversation, 'assignee' | 'status'>) => !c.assignee && c.status === 'open';
export type ConversationStatus = 'open' | 'snoozed' | 'closed';
export type ConversationCounts = { open: number; closed: number; closedWithUnread: number; unassigned: number; snoozed: number; newLeads: number };
export type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

export const PAGE_SIZE = 50;

const BASE_MESSAGE_FIELDS = 'id conversationId direction type body status error createdAt sentById senderName editedAt deletedAt version mediaMime mediaSize mediaName customerReaction teamReaction teamReactionById automation';
// Messages in a chat also bring the message they reply to (the list's last-message preview doesn't need it)
export const MESSAGE_FIELDS = `${BASE_MESSAGE_FIELDS} replyToId replyTo { id direction type body senderName deleted mediaMime mediaName }`;
const CONVERSATION_FIELDS = `id unread lastMessageAt lastInboundAt contact { id waId name leadStage country } lastMessage { ${BASE_MESSAGE_FIELDS} } labels { id name color } assignee { id name color userId } assigneeOpenedAt status closedAt closedById snoozedUntil pinned isCollaborator wasAssigned`;

// The search box, applied instantly to the chats already on screen while the server search (the same rule over
// every message) refreshes the list. Case-insensitive substring over: customer name · phone digits · the last
// message · label names · assignee name · the status words open / closed / unread / assigned / unassigned.
export function matchesSearch(
  c: Pick<Conversation, 'contact' | 'lastMessage' | 'labels' | 'assignee' | 'status' | 'unread'>,
  query: string,
) {
  const term = query.trim().toLowerCase();
  if (!term) return true;
  const digits = term.replace(/\D/g, '');
  if ((c.contact.name || '').toLowerCase().includes(term)) return true;
  if (digits.length >= 3 && c.contact.waId.includes(digits)) return true;
  if (!c.lastMessage?.deletedAt && (c.lastMessage?.body || '').toLowerCase().includes(term)) return true;
  if (c.labels.some((l) => l.name.toLowerCase().includes(term))) return true;
  if (c.assignee && c.assignee.name.toLowerCase().includes(term)) return true;
  if (term === c.status) return true;
  if (term === 'unread') return c.unread > 0;
  if (term === 'unassigned') return !c.assignee;
  if (term === 'assigned') return !!c.assignee;
  return false;
}

// WhatsApp-style bold row: the chat has unread customer messages, or it is assigned to you and you haven't opened
// it since (an open chat only). Opening the chat clears both.
export function needsAttention(c: Pick<Conversation, 'unread' | 'assignee' | 'assigneeOpenedAt' | 'status'>, meId: string | null | undefined) {
  if (c.unread > 0) return true;
  return c.status === 'open' && !!meId && c.assignee?.userId === meId && !c.assigneeOpenedAt;
}

// Optional filters: labelId, assignee (an assignee id, 'unassigned' or 'me'), status (open | closed)
export async function fetchConversations(
  after?: string | null,
  filter: {
    labelId?: string | null;
    assignee?: string | null;
    status?: ConversationStatus | null;
    search?: string | null;
    sort?: 'newest' | 'oldest' | null;
    labelIds?: string[] | null;
    assigneeIds?: string[] | null;
    from?: string | null;
    to?: string | null;
    leadStage?: string | null; // a lifecycle stage's value (left menu)
    leadStages?: string[] | null; // any of these stage values ("Filter by" → Stage)
  } = {},
) {
  const query = `query Conversations($first: Int, $after: String, $labelId: ID, $assignee: ID, $status: String, $search: String, $sort: String, $labelIds: [ID!], $assigneeIds: [ID!], $from: DateTime, $to: DateTime, $leadStage: String, $leadStages: [String!]) {
    conversations(first: $first, after: $after, labelId: $labelId, assignee: $assignee, status: $status, search: $search, sort: $sort, labelIds: $labelIds, assigneeIds: $assigneeIds, from: $from, to: $to, leadStage: $leadStage, leadStages: $leadStages) { nodes { ${CONVERSATION_FIELDS} } pageInfo { hasNextPage endCursor } }
  }`;
  return (await gql<{ conversations: Connection<Conversation> }>(query, { first: PAGE_SIZE, after, ...filter }))
    .conversations;
}

export async function fetchConversation(id: string) {
  const query = `query Conversation($id: ID!) { conversation(id: $id) { ${CONVERSATION_FIELDS} } }`;
  return (await gql<{ conversation: Conversation }>(query, { id })).conversation;
}

// Newest page first; pass the previous endCursor to load older messages. Nodes are oldest -> newest.
export async function fetchMessages(conversationId: string, after?: string | null) {
  const query = `query Messages($id: ID!, $first: Int, $after: String) {
    messages(conversationId: $id, first: $first, after: $after) { nodes { ${MESSAGE_FIELDS} } pageInfo { hasNextPage endCursor } }
  }`;
  return (await gql<{ messages: Connection<Message> }>(query, { id: conversationId, first: PAGE_SIZE, after })).messages;
}

export async function markConversationRead(id: string) {
  const query = `mutation MarkRead($id: ID!) { markConversationRead(id: $id) { id unread } }`;
  return (await gql<{ markConversationRead: { id: string; unread: number } }>(query, { id })).markConversationRead;
}

// replyToId: send it as a reply to that message of the chat (quoted above it, in the app and in WhatsApp)
export async function sendTextMessage(conversationId: string, body: string, replyToId?: string | null) {
  const query = `mutation SendText($input: SendTextInput!) { sendTextMessage(input: $input) { ${MESSAGE_FIELDS} } }`;
  return (await gql<{ sendTextMessage: Message }>(query, { input: { conversationId, body, ...(replyToId ? { replyToId } : {}) } })).sendTextMessage;
}


// My Chats: the chat's assignee is linked to this user's login. Never by name or email: unassigned chats and
// name-only assignees (no userId) are never anyone's. (The server's "me" filter applies the same rule.)
export function isAssignedTo(c: Pick<Conversation, 'assignee'>, userId: string | null | undefined) {
  return !!userId && !!c.assignee?.userId && c.assignee.userId === userId;
}

// Approved WhatsApp templates (one per name + language), live from Meta
export type MessageTemplate = { name: string; language: string; category: string; body: string; needsParameters: boolean };

export async function fetchMessageTemplates() {
  return (
    await gql<{ messageTemplates: MessageTemplate[] }>(`query Templates { messageTemplates { name language category body needsParameters } }`)
  ).messageTemplates;
}

// A chat with this number: a new one, or the one it already has (startedNow false); never a second contact
export async function startConversation(waId: string, name?: string) {
  const query = `mutation StartConversation($input: StartConversationInput!) { startConversation(input: $input) { startedNow ${CONVERSATION_FIELDS} } }`;
  return (await gql<{ startConversation: Conversation & { startedNow: boolean } }>(query, { input: { waId, name: name || undefined } })).startConversation;
}

export async function simulateIncomingMessage(input?: { waId?: string; name?: string; body?: string }) {
  const query = `mutation Simulate($input: SimulateIncomingInput) { simulateIncomingMessage(input: $input) }`;
  await gql(query, { input });
}

// Edit your own sent text message. `version` is the one you started editing from (concurrent edits are rejected).
export async function editMessage(messageId: string, body: string, version: number) {
  const query = `mutation EditMessage($input: EditMessageInput!) { editMessage(input: $input) { ${MESSAGE_FIELDS} } }`;
  return (await gql<{ editMessage: Message }>(query, { input: { messageId, body, version } })).editMessage;
}

// React to a message (sent to WhatsApp); null removes the team's reaction
export async function reactToMessage(messageId: string, emoji: string | null) {
  const query = `mutation React($id: ID!, $e: String) { reactToMessage(messageId: $id, emoji: $e) { ${MESSAGE_FIELDS} } }`;
  return (await gql<{ reactToMessage: Message }>(query, { id: messageId, e: emoji })).reactToMessage;
}
// The quick choices in the reaction bar (any other emoji from "+"), as in WhatsApp
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

// Delete for everyone in the app (the customer's WhatsApp keeps what it received)
export async function deleteMessage(messageId: string, version: number) {
  const query = `mutation DeleteMessage($id: ID!, $v: Int) { deleteMessage(messageId: $id, version: $v) { ${MESSAGE_FIELDS} } }`;
  return (await gql<{ deleteMessage: Message }>(query, { id: messageId, v: version })).deleteMessage;
}

// Undo a delete for everyone (only whoever deleted it, shortly afterwards)
export async function restoreMessage(messageId: string, version: number) {
  const query = `mutation RestoreMessage($id: ID!, $v: Int!) { restoreMessage(messageId: $id, version: $v) { ${MESSAGE_FIELDS} } }`;
  return (await gql<{ restoreMessage: Message }>(query, { id: messageId, v: version })).restoreMessage;
}

// Socket events and responses can arrive out of order: keep whichever copy is newest
export function newerMessage(current: Message, incoming: Message) {
  const senderName = incoming.senderName ?? current.senderName;
  return incoming.version >= current.version
    ? { ...incoming, senderName }
    : { ...current, status: incoming.status, error: incoming.error };
}

export async function fetchConversationCounts() {
  return (await gql<{ conversationCounts: ConversationCounts }>(`query Counts { conversationCounts { open closed closedWithUnread unassigned snoozed newLeads } }`))
    .conversationCounts;
}

type StatusFields = Pick<Conversation, 'id' | 'status' | 'closedAt' | 'closedById' | 'snoozedUntil'>;

// Close (resolve) or reopen a chat. Messages, labels and the assignee are kept.
export async function setConversationStatus(id: string, status: 'open' | 'closed') {
  const field = status === 'closed' ? 'closeConversation' : 'reopenConversation';
  const query = `mutation SetStatus($id: ID!) { ${field}(id: $id) { id status closedAt closedById snoozedUntil } }`;
  return (await gql<Record<string, StatusFields>>(query, { id }))[field];
}

// Pin / unpin for yourself (at most 3), and "Mark as unread"
export async function setConversationPinned(id: string, pinned: boolean) {
  const field = pinned ? 'pinConversation' : 'unpinConversation';
  return (await gql<Record<string, { id: string; pinned: boolean }>>(`mutation Pin($id: ID!) { ${field}(id: $id) { id pinned } }`, { id }))[field];
}
export async function markConversationUnread(id: string) {
  return (await gql<{ markConversationUnread: { id: string; unread: number } }>(`mutation Unread($id: ID!) { markConversationUnread(id: $id) { id unread } }`, { id })).markConversationUnread;
}

// Snooze until a time (back to open then, or when the customer writes)
export async function snoozeConversation(id: string, until: Date) {
  const query = `mutation Snooze($id: ID!, $until: DateTime!) { snoozeConversation(id: $id, until: $until) { id status closedAt closedById snoozedUntil } }`;
  return (await gql<{ snoozeConversation: StatusFields }>(query, { id, until: until.toISOString() })).snoozeConversation;
}

// Clear chat for yourself only (like WhatsApp); nothing is deleted and teammates still see everything
export async function clearConversation(id: string) {
  await gql(`mutation ClearChat($id: ID!) { clearConversation(id: $id) }`, { id });
}
