import { env } from '../env.js';
import { AppError } from '../services/errors.js';
import { TEMPLATE_LANGUAGES } from '../services/templateModel.js';
import { allTemplates, approvedTemplates, createMessageTemplate, deleteMessageTemplate, sendTemplateMessage, updateMessageTemplate } from '../services/templates.js';
import { reactToMessage } from '../services/reactions.js';
import { withSender } from '../services/senders.js';
import { prisma } from '../prisma.js';
import { toAssigneeRef } from '../services/assign.js';
import { conversationLabels } from '../services/labels.js';
import { clearConversation, clearedAt } from '../services/conversationClear.js';
import { closeConversation, conversationCounts, reopenConversation, snoozeConversation } from '../services/conversationStatus.js';
import { markConversationUnread, pinConversation, pinnedIds, unpinConversation } from '../services/conversationPins.js';
import { addCollaborators, listCollaborators, removeCollaborator } from '../services/collaborators.js';
import type { Context } from './shared.js';
import { deleteMessage, editMessage, restoreMessage } from '../services/messageActions.js';
import { type Quote, quoteOf, senderName } from '../services/senders.js';
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
    "The customer's reaction (an emoji), as in WhatsApp; null = none"
    customerReaction: String
    "The business's reaction (one for the whole team); null = none"
    teamReaction: String
    "Who on the team reacted"
    teamReactionById: ID
    "Sent by Simple automations (e.g. auto_reply), not by a person; null otherwise"
    automation: String
    "pending | sent | delivered | read | failed | received"
    status: String!
    error: String
    createdAt: DateTime!
    "Agent (user id) who sent an outgoing message; null for customer messages and older ones"
    sentById: ID
    "Who sent it, from the database: the agent's name, or the customer's name (or number). Null for older agent messages with no recorded sender."
    senderName: String
    "A reply: the message in this chat it quotes (as WhatsApp shows it above the reply)"
    replyToId: ID
    replyTo: QuotedMessage
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
    "You are a collaborator on this chat (it shows in your Collaborations)"
    isCollaborator: Boolean!
    "Was ever assigned to someone (its assignment history): such a chat is no longer a New Lead, even if unassigned again"
    wasAssigned: Boolean!
  }

  type ConversationCounts {
    open: Int!
    closed: Int!
    "Closed chats with unread customer messages"
    closedWithUnread: Int!
    "Snoozed chats (they wake up on their own)"
    snoozed: Int!
    "Chats with no assignee (the Unassigned filter)"
    unassigned: Int!
    "New Leads: open, unassigned chats that were never assigned"
    newLeads: Int!
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

  "The message a reply quotes"
  type QuotedMessage {
    id: ID!
    direction: MessageDirection!
    type: String!
    "Empty once deleted"
    body: String!
    senderName: String
    deleted: Boolean!
    mediaMime: String
    mediaName: String
  }

  input SendTextInput {
    conversationId: ID!
    body: String!
    "Reply to this message of the chat (quoted above the text, in the app and in WhatsApp)"
    replyToId: ID
  }

  input SendTemplateInput {
    conversationId: ID!
    name: String!
    "Language code exactly as approved, e.g. en_US. Omit to use the template's only approved language."
    language: String
    "JSON: { header: { var: value }, body: { var: value }, buttons: { index: value } } (variables by name or number)"
    values: String
  }

  "An approved WhatsApp template (one per name + language)"
  type MessageTemplate {
    "Meta's id of this template (one per name + language)"
    id: ID!
    name: String!
    "Language code as approved by Meta, e.g. en or en_US"
    language: String!
    "MARKETING | UTILITY | AUTHENTICATION"
    category: String!
    "APPROVED | PENDING | REJECTED | PAUSED | DISABLED | …"
    status: String!
    rejectedReason: String
    "POSITIONAL ({{1}}) or NAMED ({{name}}) variables"
    parameterFormat: String!
    header: TemplateHeader
    "Body text, for preview"
    body: String!
    "The body's variables, in order (e.g. 1, 2 or customer_name)"
    bodyVariables: [String!]!
    footer: String
    buttons: [TemplateButton!]!
    "Has values to fill in (variables, a media header, a coupon or code)"
    needsParameters: Boolean!
    "Whether it can be sent from this app (carousels, catalogs and flows can't yet)"
    sendable: Boolean!
    unsupportedReason: String
  }

  type TemplateHeader {
    "TEXT | IMAGE | VIDEO | DOCUMENT | LOCATION"
    format: String!
    text: String!
    variables: [String!]!
  }

  type TemplateButton {
    "QUICK_REPLY | URL | PHONE_NUMBER | COPY_CODE | OTP | …"
    type: String!
    text: String!
    url: String
    phoneNumber: String
    "URL buttons: the variable part of the link"
    variables: [String!]!
  }

  type CreatedTemplate {
    id: ID!
    "Usually PENDING (Meta reviews it)"
    status: String!
    category: String!
  }

  "Settings → Templates: what the editor offers"
  type TemplateEditorInfo {
    languages: [TemplateLanguage!]!
    "Whether media-header templates can be created (needs META_APP_ID on the server)"
    mediaHeaderAvailable: Boolean!
  }

  type TemplateLanguage {
    value: String!
    label: String!
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
    "Newest first. first: 1-100 (default 50). labelId: only conversations with that label. assignee: an assignee id, 'unassigned', 'me' (assigned to you), 'collaborating' (only chats you collaborate on), or 'new_leads' (open, unassigned, never assigned). status: open | closed · search: one box for everything, case-insensitive substring: customer name, phone digits, any message text, label name, assignee name, or the words open / closed / unread / assigned / unassigned"
    conversations(first: Int, after: String, labelId: ID, assignee: ID, status: String, search: String, sort: String, labelIds: [ID!], assigneeIds: [ID!], from: DateTime, to: DateTime, leadStage: String): ConversationConnection!
    conversationCounts: ConversationCounts!
    "Approved templates of the connected number, live from Meta"
    messageTemplates: [MessageTemplate!]!
    "Admins: every template of the number, any status (Settings → Templates)"
    allMessageTemplates: [MessageTemplate!]!
    templateEditorInfo: TemplateEditorInfo!
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
    "Admins: submit a new template for Meta's review. spec: JSON (see services/templateModel templateSpecSchema). Media headers: POST /templates"
    createMessageTemplate(spec: String!): CreatedTemplate!
    "Admins: change a template (Meta reviews it again); name and language stay"
    updateMessageTemplate(id: ID!, spec: String!): Boolean!
    "Admins: delete a template (with id: that language only)"
    deleteMessageTemplate(name: String!, id: ID): Boolean!
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
    "React to a message with an emoji (sent to WhatsApp); empty or null removes the team's reaction"
    reactToMessage(messageId: ID!, emoji: String): Message!
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
  _count?: { assignments?: number };
};

// JSON arguments (template values and specs) are checked by the services' schemas after parsing
function jsonInput(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError('Invalid JSON', 400, 'BAD_USER_INPUT');
  }
}

export const resolvers = {
  MessageTemplate: {
    body: (t: { body: { text: string } | string }) => (typeof t.body === 'string' ? t.body : t.body.text),
    bodyVariables: (t: { body: { variables: string[] } | string }) => (typeof t.body === 'string' ? [] : t.body.variables),
    needsParameters: (t: { needsParameters?: boolean }) => !!t.needsParameters,
  },
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
    messageTemplates: authed((_args, auth) => approvedTemplates(auth)),
    allMessageTemplates: authed((_args, auth) => allTemplates(auth)),
    templateEditorInfo: authed(async () => ({ languages: TEMPLATE_LANGUAGES, mediaHeaderAvailable: !!env.metaAppId })),
    conversation: authed(({ id }: { id: string }, { workspaceId }) => requireConversation(workspaceId, id)),
    messages: authed(async ({ conversationId, ...args }: PageArgs & { conversationId: string }, { workspaceId, userId }) =>
      toConnection(
        await listMessages(workspaceId, conversationId, pageArgs(args), await clearedAt(userId, conversationId)),
      ),
    ),
  },
  Mutation: {
    markConversationRead: authed(({ id }: { id: string }, { workspaceId, userId }) => markConversationRead(workspaceId, id, userId)),
    sendTextMessage: authed(({ input }: { input: { conversationId: string; body: string; replyToId?: string | null } }, { workspaceId, userId }) =>
      sendMessage(workspaceId, input.conversationId, { type: 'text', body: input.body, replyToId: input.replyToId }, userId),
    ),
    sendTemplateMessage: authed(async ({ input }: { input: { conversationId: string; name: string; language?: string | null; values?: string | null } }, auth) =>
      withSender(
        await sendTemplateMessage(auth, {
          conversationId: input.conversationId,
          name: input.name,
          language: input.language ?? undefined,
          values: input.values ? jsonInput(input.values) : undefined,
        }),
      ),
    ),
    createMessageTemplate: authed(async ({ spec }: { spec: string }, auth) => createMessageTemplate(auth, jsonInput(spec))),
    updateMessageTemplate: authed(async ({ id, spec }: { id: string; spec: string }, auth) => updateMessageTemplate(auth, id, jsonInput(spec))),
    deleteMessageTemplate: authed(async ({ name, id }: { name: string; id?: string | null }, auth) => deleteMessageTemplate(auth, name, id)),
    editMessage: authed(({ input }: { input: { messageId: string; body: string; version: number } }, auth) =>
      editMessage(auth, input.messageId, { body: input.body, version: input.version }),
    ),
    reactToMessage: authed(async ({ messageId, emoji }: { messageId: string; emoji?: string | null }, auth) =>
      withSender(await reactToMessage(auth, messageId, emoji ?? null)),
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
    replyTo: (m: { replyToId?: string | null; replyTo?: Quote | null }) => (m.replyTo !== undefined ? m.replyTo : quoteOf(m.replyToId)),
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
    // List queries count the chat's past assignments in the same request; otherwise look it up
    wasAssigned: async (c: ConversationParent) =>
      c._count?.assignments !== undefined
        ? c._count.assignments > 0
        : !!(await prisma.assignmentRecord.findFirst({ where: { conversationId: c.id }, select: { id: true } })),
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
