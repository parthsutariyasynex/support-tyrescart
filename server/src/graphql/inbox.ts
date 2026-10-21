import { prisma } from '../prisma.js';
import { toAssigneeRef } from '../services/assign.js';
import { conversationLabels } from '../services/labels.js';
import { clearConversation, clearedAt } from '../services/conversationClear.js';
import { closeConversation, conversationCounts, reopenConversation, snoozeConversation } from '../services/conversationStatus.js';
import { markConversationUnread, pinConversation, pinnedIds, unpinConversation } from '../services/conversationPins.js';
import { addCollaborators, listCollaborators, removeCollaborator } from '../services/collaborators.js';
import type { Context } from './shared.js';
import { deleteMessage, editMessage, restoreMessage } from '../services/messageActions.js';
import { senderName } from '../services/senders.js';
import {
  listConversations,
  listMessages,
  listMessageTemplates,
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
    "Images and documents sent from the app: their type, e.g. image/png or application/pdf (the file: GET /inbox/messages/{id}/media). Null otherwise."
    mediaMime: String
    mediaSize: Int
    "Documents: the file name"
    mediaName: String
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
    "When the current assignee first opened the chat after it was assigned to them; null = not yet (shown bold in their list, reminded every few minutes)"
    assigneeOpenedAt: DateTime
    "open | closed. New customer messages don't reopen a closed chat; they still count as unread."
    status: String!
    closedAt: DateTime
    "User id of whoever closed it"
    closedById: ID
    "status = snoozed: back to open at this time, or as soon as the customer writes"
    snoozedUntil: DateTime
    "Pinned to the top of your list (per person)"
    pinned: Boolean!
    "Teammates added to this chat besides the assignee (they get its notifications)"
    collaborators: [WorkspaceMember!]!
    "You are a collaborator on this chat (it shows in your My Chats)"
    isCollaborator: Boolean!
  }

  type ConversationCounts {
    open: Int!
    closed: Int!
    "Closed chats with unread customer messages"
    closedWithUnread: Int!
    "Snoozed chats (they wake up on their own)"
    snoozed: Int!
    "Chats with no assignee (the Unassigned filter / New Leads)"
    unassigned: Int!
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
    "Language code exactly as approved, e.g. en_US. Omit to use the template's only approved language."
    language: String
  }

  "An approved WhatsApp template (one per name + language)"
  type MessageTemplate {
    name: String!
    "Language code as approved by Meta, e.g. en or en_US"
    language: String!
    category: String!
    "Body text, for preview"
    body: String!
    "Has {{variables}} or a media header; can't be sent from the inbox yet"
    needsParameters: Boolean!
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
    "Dev/test: a file the customer sends (stored straight away)"
    media: SimulateMediaInput
  }

  input SimulateMediaInput {
    "image | video | audio | voice | document | sticker"
    type: String!
    mime: String!
    base64: String!
    filename: String
    caption: String
  }

  extend type Query {
    "Newest first. first: 1-100 (default 50). labelId: only conversations with that label. assignee: an assignee id, 'unassigned', 'me' (assigned to you or collaborating), or 'collaborating' (only chats you collaborate on). status: open | closed · search: one box for everything, case-insensitive substring: customer name, phone digits, any message text, label name, assignee name, or the words open / closed / unread / assigned / unassigned"
    conversations(first: Int, after: String, labelId: ID, assignee: ID, status: String, search: String, sort: String, labelIds: [ID!], assigneeIds: [ID!], from: DateTime, to: DateTime, leadStage: String): ConversationConnection!
    conversationCounts: ConversationCounts!
    "Approved templates of the connected number, live from Meta"
    messageTemplates: [MessageTemplate!]!
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
    "Hide the chat until this time (at most a year ahead); it comes back to open then, or when the customer writes"
    snoozeConversation(id: ID!, until: DateTime!): Conversation!
    "Keep this chat at the top of your own list (at most 3; PIN_LIMIT otherwise)"
    pinConversation(id: ID!): Conversation!
    unpinConversation(id: ID!): Conversation!
    "Back to unread (bold with a badge) until someone opens it"
    markConversationUnread(id: ID!): Conversation!
    "Add teammates (user ids) as collaborators: every role"
    addCollaborators(conversationId: ID!, userIds: [ID!]!): [WorkspaceMember!]!
    removeCollaborator(conversationId: ID!, userId: ID!): [WorkspaceMember!]!
    "Edit the text of your own sent message (owners/admins: any sent message). Doesn't change what the customer received."
    editMessage(input: EditMessageInput!): Message!
    "Delete for everyone in the app (own messages; owners/admins: any sent message). Pass version to guard against concurrent edits."
    deleteMessage(messageId: ID!, version: Int): Message!
    "Undo a delete for everyone: only whoever deleted it, shortly afterwards, and only if nothing changed since"
    restoreMessage(messageId: ID!, version: Int!): Message!
  }
`;

type PageArgs = { first?: number | null; after?: string | null };
type ConversationPageArgs = PageArgs & { labelId?: string | null; assignee?: string | null; status?: string | null; search?: string | null; sort?: string | null; labelIds?: string[] | null; assigneeIds?: string[] | null; from?: Date | null; to?: Date | null; leadStage?: string | null };
const pageArgs = ({ first, after }: PageArgs) => ({ first: first ?? undefined, after: after ?? undefined });

type AssigneeRefMember = { id: string; role: string; user: { id: string; name: string } };

const pinCache = new WeakMap<object, Promise<string[]>>();
const collabCache = new WeakMap<object, Promise<string[]>>();

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
    conversations: authed(async ({ labelId, assignee, status, search, sort, labelIds, assigneeIds, from, to, leadStage, ...args }: ConversationPageArgs, { workspaceId, userId }) =>
      toConnection(
        (await listConversations(
          workspaceId,
          { ...pageArgs(args), labelId: labelId ?? undefined, assignee: assignee ?? undefined, status: status ?? undefined, search: search?.trim() || undefined, sort: sort ?? undefined, labelIds: labelIds ?? undefined, assigneeIds: assigneeIds ?? undefined, from: from ?? undefined, to: to ?? undefined, leadStage: leadStage ?? undefined },
          userId,
        )) as Page<ConversationParent>,
      ),
    ),
    conversationCounts: authed((_args, { workspaceId }) => conversationCounts(workspaceId)),
    messageTemplates: authed((_args, { workspaceId }) => listMessageTemplates(workspaceId)),
    conversation: authed(({ id }: { id: string }, { workspaceId }) => requireConversation(workspaceId, id)),
    messages: authed(async ({ conversationId, ...args }: PageArgs & { conversationId: string }, { workspaceId, userId }) =>
      toConnection(
        await listMessages(workspaceId, conversationId, pageArgs(args), await clearedAt(userId, conversationId)),
      ),
    ),
  },
  Mutation: {
    markConversationRead: authed(({ id }: { id: string }, { workspaceId, userId }) => markConversationRead(workspaceId, id, userId)),
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
    snoozeConversation: authed(({ id, until }: { id: string; until: Date }, auth) => snoozeConversation(auth, id, until)),
    pinConversation: authed(({ id }: { id: string }, auth) => pinConversation(auth, id)),
    unpinConversation: authed(({ id }: { id: string }, auth) => unpinConversation(auth, id)),
    markConversationUnread: authed(({ id }: { id: string }, auth) => markConversationUnread(auth, id)),
    addCollaborators: authed(({ conversationId, userIds }: { conversationId: string; userIds: string[] }, auth) => addCollaborators(auth, conversationId, userIds)),
    removeCollaborator: authed(({ conversationId, userId }: { conversationId: string; userId: string }, auth) => removeCollaborator(auth, conversationId, userId)),
    restoreMessage: authed(({ messageId, version }: { messageId: string; version: number }, auth) =>
      restoreMessage(auth, messageId, { version }),
    ),
    startConversation: authed(({ input }: { input: unknown }, { workspaceId, userId }) => startConversation(workspaceId, input, userId)),
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
    // Whether the viewer pinned it; their pins are read once per request, not once per chat
    pinned: async (c: ConversationParent, _args: unknown, ctx: Context) => {
      if (!ctx.auth) return false;
      let ids = pinCache.get(ctx);
      if (!ids) pinCache.set(ctx, (ids = pinnedIds(ctx.auth.userId, ctx.auth.workspaceId)));
      return (await ids).includes(c.id);
    },
    collaborators: (c: ConversationParent, _args: unknown, ctx: Context) => (ctx.auth ? listCollaborators(ctx.auth.workspaceId, c.id) : []),
    // The viewer's collaborations are read once per request, not once per chat
    isCollaborator: async (c: ConversationParent, _args: unknown, ctx: Context) => {
      if (!ctx.auth) return false;
      const { userId } = ctx.auth;
      let ids = collabCache.get(ctx);
      if (!ids) collabCache.set(ctx, (ids = prisma.conversationCollaborator.findMany({ where: { userId }, select: { conversationId: true } }).then((r) => r.map((x) => x.conversationId))));
      return (await ids).includes(c.id);
    },
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
    // The holding member, in the assignee shape (id = member id, name, role colour, userId)
    assignee: async (c: ConversationParent) => {
      const member =
        c.assignedTo !== undefined
          ? (c.assignedTo as AssigneeRefMember | null)
          : c.assignedToId
            ? await prisma.member.findUnique({ where: { id: c.assignedToId }, include: { user: { select: { id: true, name: true } } } })
            : null;
      return member ? toAssigneeRef(member) : null;
    },
  },
};
