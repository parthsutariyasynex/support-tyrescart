import { prisma } from '../prisma.js';
import {
  listConversations,
  listMessages,
  markConversationRead,
  requireConversation,
  sendMessage,
  simulateIncoming,
  startConversation,
  type Page,
} from '../services/inbox.js';
import { authed, toConnection } from './shared.js';

export const typeDefs = /* GraphQL */ `
  enum MessageDirection {
    in
    out
  }

  type Contact {
    id: ID!
    waId: String!
    name: String
    createdAt: DateTime!
  }

  type Message {
    id: ID!
    conversationId: ID!
    direction: MessageDirection!
    "text | template | button | interactive | image | ..."
    type: String!
    body: String!
    "pending | sent | delivered | read | failed | received"
    status: String!
    error: String
    createdAt: DateTime!
  }

  type Conversation {
    id: ID!
    contact: Contact!
    unread: Int!
    lastMessageAt: DateTime!
    "Customer's last inbound message; free-form replies are allowed for 24h after it"
    lastInboundAt: DateTime
    lastMessage: Message
  }

  type ConversationConnection {
    nodes: [Conversation!]!
    pageInfo: PageInfo!
  }

  "Messages oldest -> newest. Pass pageInfo.endCursor as 'after' to load older messages."
  type MessageConnection {
    nodes: [Message!]!
    pageInfo: PageInfo!
  }

  input SendTextInput {
    conversationId: ID!
    body: String!
  }

  input SendTemplateInput {
    conversationId: ID!
    name: String!
    language: String
  }

  input StartConversationInput {
    "Number with country code, e.g. 919876543210"
    waId: String!
    name: String
  }

  input SimulateIncomingInput {
    waId: String
    name: String
    body: String
  }

  extend type Query {
    "Newest first. first: 1-100 (default 50)"
    conversations(first: Int, after: String): ConversationConnection!
    conversation(id: ID!): Conversation!
    "Newest page first. first: 1-100 (default 50)"
    messages(conversationId: ID!, first: Int, after: String): MessageConnection!
  }

  extend type Mutation {
    markConversationRead(id: ID!): Conversation!
    "Free-form text; only inside the 24-hour customer service window"
    sendTextMessage(input: SendTextInput!): Message!
    "Approved template; allowed any time"
    sendTemplateMessage(input: SendTemplateInput!): Message!
    startConversation(input: StartConversationInput!): Conversation!
    "Development only: fakes an incoming customer message"
    simulateIncomingMessage(input: SimulateIncomingInput): Boolean!
  }
`;

type PageArgs = { first?: number | null; after?: string | null };
const pageArgs = ({ first, after }: PageArgs) => ({ first: first ?? undefined, after: after ?? undefined });

type ConversationParent = { id: string; contactId: string; contact?: unknown; messages?: unknown[] };

export const resolvers = {
  Query: {
    conversations: authed(async (args: PageArgs, { workspaceId }) =>
      toConnection((await listConversations(workspaceId, pageArgs(args))) as Page<ConversationParent>),
    ),
    conversation: authed(({ id }: { id: string }, { workspaceId }) => requireConversation(workspaceId, id)),
    messages: authed(async ({ conversationId, ...args }: PageArgs & { conversationId: string }, { workspaceId }) =>
      toConnection(await listMessages(workspaceId, conversationId, pageArgs(args))),
    ),
  },
  Mutation: {
    markConversationRead: authed(({ id }: { id: string }, { workspaceId }) => markConversationRead(workspaceId, id)),
    sendTextMessage: authed(({ input }: { input: { conversationId: string; body: string } }, { workspaceId }) =>
      sendMessage(workspaceId, input.conversationId, { type: 'text', body: input.body }),
    ),
    sendTemplateMessage: authed(
      ({ input }: { input: { conversationId: string; name: string; language?: string | null } }, { workspaceId }) =>
        sendMessage(workspaceId, input.conversationId, {
          type: 'template',
          name: input.name,
          language: input.language ?? undefined,
        }),
    ),
    startConversation: authed(({ input }: { input: unknown }, { workspaceId }) => startConversation(workspaceId, input)),
    simulateIncomingMessage: authed(async ({ input }: { input?: Record<string, unknown> | null }, { workspaceId }) => {
      // GraphQL sends explicit nulls for omitted fields; drop them so defaults apply
      const clean = Object.fromEntries(Object.entries(input ?? {}).filter(([, v]) => v != null));
      await simulateIncoming(workspaceId, clean);
      return true;
    }),
  },
  // Services already include these for list queries; fall back to a lookup otherwise
  Conversation: {
    contact: (c: ConversationParent) => c.contact ?? prisma.contact.findUnique({ where: { id: c.contactId } }),
    lastMessage: (c: ConversationParent) =>
      c.messages
        ? (c.messages[0] ?? null)
        : prisma.message.findFirst({ where: { conversationId: c.id }, orderBy: { createdAt: 'desc' } }),
  },
};
