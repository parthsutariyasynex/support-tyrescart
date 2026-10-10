import { gql } from './api';
import type { Assignee } from './assignees';
import type { Label } from './labels';

export type Contact = { id: string; waId: string; name: string | null };
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
};
export type Conversation = {
  id: string;
  contact: Contact;
  unread: number;
  lastMessageAt: string;
  lastInboundAt: string | null;
  lastMessage: Message | null;
  labels: Pick<Label, 'id' | 'name' | 'color'>[];
  assignee: Pick<Assignee, 'id' | 'name' | 'color'> | null;
  // Closed chats keep everything; new customer messages don't reopen them
  status: ConversationStatus;
  closedAt: string | null;
  closedById: string | null;
};
export type ConversationStatus = 'open' | 'closed';
export type ConversationCounts = { open: number; closed: number; closedWithUnread: number };
export type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

export const PAGE_SIZE = 50;

const MESSAGE_FIELDS = 'id conversationId direction type body status error createdAt sentById senderName editedAt deletedAt version';
const CONVERSATION_FIELDS = `id unread lastMessageAt lastInboundAt contact { id waId name } lastMessage { ${MESSAGE_FIELDS} } labels { id name color } assignee { id name color } status closedAt closedById`;

// Optional filters: labelId, assignee (an assignee id or 'unassigned'), status (open | closed)
export async function fetchConversations(
  after?: string | null,
  filter: { labelId?: string | null; assignee?: string | null; status?: ConversationStatus | null } = {},
) {
  const query = `query Conversations($first: Int, $after: String, $labelId: ID, $assignee: ID, $status: String) {
    conversations(first: $first, after: $after, labelId: $labelId, assignee: $assignee, status: $status) { nodes { ${CONVERSATION_FIELDS} } pageInfo { hasNextPage endCursor } }
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

export async function sendTextMessage(conversationId: string, body: string) {
  const query = `mutation SendText($input: SendTextInput!) { sendTextMessage(input: $input) { ${MESSAGE_FIELDS} } }`;
  return (await gql<{ sendTextMessage: Message }>(query, { input: { conversationId, body } })).sendTextMessage;
}

export async function sendTemplateMessage(conversationId: string, name: string, language?: string) {
  const query = `mutation SendTemplate($input: SendTemplateInput!) { sendTemplateMessage(input: $input) { ${MESSAGE_FIELDS} } }`;
  return (await gql<{ sendTemplateMessage: Message }>(query, { input: { conversationId, name, language } }))
    .sendTemplateMessage;
}

export async function startConversation(waId: string, name?: string) {
  const query = `mutation StartConversation($input: StartConversationInput!) { startConversation(input: $input) { ${CONVERSATION_FIELDS} } }`;
  return (await gql<{ startConversation: Conversation }>(query, { input: { waId, name } })).startConversation;
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
  return (await gql<{ conversationCounts: ConversationCounts }>(`query Counts { conversationCounts { open closed closedWithUnread } }`))
    .conversationCounts;
}

type StatusFields = Pick<Conversation, 'id' | 'status' | 'closedAt' | 'closedById'>;

// Close (resolve) or reopen a chat. Messages, labels and the assignee are kept.
export async function setConversationStatus(id: string, status: ConversationStatus) {
  const field = status === 'closed' ? 'closeConversation' : 'reopenConversation';
  const query = `mutation SetStatus($id: ID!) { ${field}(id: $id) { id status closedAt closedById } }`;
  return (await gql<Record<string, StatusFields>>(query, { id }))[field];
}

// Clear chat for yourself only (like WhatsApp); nothing is deleted and teammates still see everything
export async function clearConversation(id: string) {
  await gql(`mutation ClearChat($id: ID!) { clearConversation(id: $id) }`, { id });
}
