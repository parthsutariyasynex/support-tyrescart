import { prisma } from '../prisma.js';
import { conversationLabels } from '../services/labels.js';
import { clearConversation, clearedAt } from '../services/conversationClear.js';
import { closeConversation, conversationCounts, reopenConversation } from '../services/conversationStatus.js';
import type { Context } from './shared.js';
import { deleteMessage, editMessage, restoreMessage } from '../services/messageActions.js';
import { senderName } from '../services/senders.js';
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
    "Agent (user id) who sent an outgoing message; null for customer messages and older ones"
    sentById: ID
    "Who sent it, from the database: the agent's name, or the customer's name (or number). Null for older agent messages with no recorded sender."
    senderName: String
    "Set when the text was edited"
    editedAt: DateTime
    "Set when deleted for everyone; body is then empty"
    deletedAt: DateTime
    "Increases on every edit/delete; pass it back to editMessage so concurrent edits are detected"
    version: Int!
  }

  input EditMessageInput {
    messageId: ID!
    body: String!
    "The version you started editing from"
    version: Int!
  }

  type Conversation {
    id: ID!
    contact: Contact!
    unread: Int!
    lastMessageAt: DateTime!
    "Customer's last inbound message; free-form replies are allowed for 24h after it"
    lastInboundAt: DateTime
    lastMessage: Message
    "Sorted by name"
    labels: [Label!]!
    "Null when unassigned"
    assignee: Assignee
    "open | closed. New customer messages don't reopen a closed chat; they still count as unread."
    status: String!
    closedAt: DateTime
    "User id of whoever closed it"
    closedById: ID
  }

  type ConversationCounts {
    open: Int!
    closed: Int!
    "Closed chats with unread customer messages"
    closedWithUnread: Int!
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
    "Newest first. first: 1-100 (default 50). labelId: only conversations with that label. assignee: an assignee id, or 'unassigned'. status: open | closed"
    conversations(first: Int, after: String, labelId: ID, assignee: ID, status: String): ConversationConnection!
    conversationCounts: ConversationCounts!
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
    "Clear chat for yourself only (like WhatsApp): hides everything so far from your view; nothing is deleted"
    clearConversation(id: ID!): DateTime!
    "Mark the chat closed/resolved. Keeps messages, labels and the assignee."
    closeConversation(id: ID!): Conversation!
    reopenConversation(id: ID!): Conversation!
    "Edit the text of your own sent message (owners/admins: any sent message). Doesn't change what the customer received."
    editMessage(input: EditMessageInput!): Message!
    "Delete for everyone in the app (own messages; owners/admins: any sent message). Pass version to guard against concurrent edits."
    deleteMessage(messageId: ID!, version: Int): Message!
    "Undo a delete for everyone: only whoever deleted it, shortly afterwards, and only if nothing changed since"
    restoreMessage(messageId: ID!, version: Int!): Message!
  }
`;

type PageArgs = { first?: number | null; after?: string | null };
type ConversationPageArgs = PageArgs & { labelId?: string | null; assignee?: string | null; status?: string | null };
const pageArgs = ({ first, after }: PageArgs) => ({ first: first ?? undefined, after: after ?? undefined });

type ConversationParent = {
  id: string;
  contactId: string;
  assignedToId: string | null;
  contact?: unknown;
  messages?: unknown[];
  labels?: { label: { name: string } }[];
  assignedTo?: unknown;
};

export const resolvers = {
  Query: {
    conversations: authed(async ({ labelId, assignee, status, ...args }: ConversationPageArgs, { workspaceId }) =>
      toConnection(
        (await listConversations(workspaceId, {
          ...pageArgs(args),
          labelId: labelId ?? undefined,
          assignee: assignee ?? undefined,
          status: status ?? undefined,
        })) as Page<ConversationParent>,
      ),
    ),
    conversationCounts: authed((_args, { workspaceId }) => conversationCounts(workspaceId)),
    conversation: authed(({ id }: { id: string }, { workspaceId }) => requireConversation(workspaceId, id)),
    messages: authed(async ({ conversationId, ...args }: PageArgs & { conversationId: string }, { workspaceId, userId }) =>
      toConnection(
        await listMessages(workspaceId, conversationId, pageArgs(args), await clearedAt(userId, conversationId)),
      ),
    ),
  },
  Mutation: {
    markConversationRead: authed(({ id }: { id: string }, { workspaceId }) => markConversationRead(workspaceId, id)),
    sendTextMessage: authed(({ input }: { input: { conversationId: string; body: string } }, { workspaceId, userId }) =>
      sendMessage(workspaceId, input.conversationId, { type: 'text', body: input.body }, userId),
    ),
    sendTemplateMessage: authed(
      (
        { input }: { input: { conversationId: string; name: string; language?: string | null } },
        { workspaceId, userId },
      ) =>
        sendMessage(
          workspaceId,
          input.conversationId,
          { type: 'template', name: input.name, language: input.language ?? undefined },
          userId,
        ),
    ),
    editMessage: authed(({ input }: { input: { messageId: string; body: string; version: number } }, auth) =>
      editMessage(auth, input.messageId, { body: input.body, version: input.version }),
    ),
    deleteMessage: authed(({ messageId, version }: { messageId: string; version?: number | null }, auth) =>
      deleteMessage(auth, messageId, version == null ? {} : { version }),
    ),
    clearConversation: authed(({ id }: { id: string }, auth) => clearConversation(auth, id)),
    closeConversation: authed(({ id }: { id: string }, auth) => closeConversation(auth, id)),
    reopenConversation: authed(({ id }: { id: string }, auth) => reopenConversation(auth, id)),
    restoreMessage: authed(({ messageId, version }: { messageId: string; version: number }, auth) =>
      restoreMessage(auth, messageId, { version }),
    ),
    startConversation: authed(({ input }: { input: unknown }, { workspaceId }) => startConversation(workspaceId, input)),
    simulateIncomingMessage: authed(async ({ input }: { input?: Record<string, unknown> | null }, { workspaceId }) => {
      // GraphQL sends explicit nulls for omitted fields; drop them so defaults apply
      const clean = Object.fromEntries(Object.entries(input ?? {}).filter(([, v]) => v != null));
      await simulateIncoming(workspaceId, clean);
      return true;
    }),
  },
  // Deleted messages never expose their old text, whatever path loaded them
  Message: {
    body: (m: { body: string; deletedAt?: Date | null }) => (m.deletedAt ? '' : m.body),
    senderName: (m: { direction: string; sentById: string | null; conversationId: string; senderName?: string | null }) =>
      m.senderName !== undefined ? m.senderName : senderName(m),
  },
  // Services already include these for list queries; fall back to a lookup otherwise
  Conversation: {
    contact: (c: ConversationParent) => c.contact ?? prisma.contact.findUnique({ where: { id: c.contactId } }),
    // Hidden for someone who cleared the chat after it was sent
    lastMessage: async (c: ConversationParent, _args: unknown, ctx: Context) => {
      const last = (
        c.messages
          ? (c.messages[0] ?? null)
          : await prisma.message.findFirst({ where: { conversationId: c.id }, orderBy: { createdAt: 'desc' } })
      ) as { createdAt: Date } | null;
      const cleared = await clearedAt(ctx.auth?.userId, c.id);
      return last && cleared && last.createdAt <= cleared ? null : last;
    },
    labels: (c: ConversationParent) =>
      c.labels
        ? c.labels.map((l) => l.label).sort((a, b) => a.name.localeCompare(b.name))
        : conversationLabels(c.id),
    assignee: (c: ConversationParent) =>
      c.assignedTo !== undefined
        ? c.assignedTo
        : c.assignedToId
          ? prisma.assignee.findUnique({ where: { id: c.assignedToId } })
          : null,
  },
};
