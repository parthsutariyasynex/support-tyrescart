import { gql } from './api';

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
};
export type Conversation = {
  id: string;
  contact: Contact;
  unread: number;
  lastMessageAt: string;
  lastInboundAt: string | null;
  lastMessage: Message | null;
};
export type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

export const PAGE_SIZE = 50;

const MESSAGE_FIELDS = 'id conversationId direction type body status error createdAt';
const CONVERSATION_FIELDS = `id unread lastMessageAt lastInboundAt contact { id waId name } lastMessage { ${MESSAGE_FIELDS} }`;

export async function fetchConversations(after?: string | null) {
  const query = `query Conversations($first: Int, $after: String) {
    conversations(first: $first, after: $after) { nodes { ${CONVERSATION_FIELDS} } pageInfo { hasNextPage endCursor } }
  }`;
  return (await gql<{ conversations: Connection<Conversation> }>(query, { first: PAGE_SIZE, after })).conversations;
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
