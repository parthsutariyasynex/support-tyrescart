import { isValidPhoneNumber } from 'libphonenumber-js/max';
import { z } from 'zod';
import { env } from '../env.js';
import { saveIncoming } from '../messages.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { type ApprovedTemplate, listApprovedTemplates, sendTemplate, sendText } from '../whatsapp.js';
import { AppError, notFound } from './errors.js';
import { withSender } from './senders.js';
import { parse } from './validate.js';

const DAY = 24 * 60 * 60 * 1000;
export const MAX_PAGE_SIZE = 100;

const pageSchema = z.object({
  first: z.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  after: z.string().min(1).optional(),
});

const conversationPageSchema = pageSchema.extend({
  labelId: z.string().min(1).optional(),
  assignee: z.string().min(1).optional(),
  status: z.enum(['open', 'closed']).optional(),
});

export type Page<T> = { nodes: T[]; hasNextPage: boolean; endCursor: string | null };

// Fetch one extra row to know whether another page exists
function toPage<T extends { id: string }>(rows: T[], first: number): Page<T> {
  const nodes = rows.slice(0, first);
  return { nodes, hasNextPage: rows.length > first, endCursor: nodes.at(-1)?.id ?? null };
}

const conversationInclude = {
  contact: true,
  messages: { orderBy: { createdAt: 'desc' as const }, take: 1 },
  labels: { include: { label: true } },
  assignedTo: true,
};

// Newest first. Omit `page` to get every conversation (REST behaviour).
// `labelId` keeps only conversations that have that label; `assignee` is an assignee id, 'unassigned', or 'me'
// (assigned to the assignee linked to `viewerId`); `status` is 'open' or 'closed' (omit for both).
export async function listConversations(workspaceId: string, page?: unknown, viewerId?: string) {
  const query = {
    where: { workspaceId },
    orderBy: [{ lastMessageAt: 'desc' as const }, { id: 'desc' as const }],
    include: conversationInclude,
  };
  if (page === undefined) return prisma.conversation.findMany(query);

  const { first, after, labelId, assignee, status } = parse(conversationPageSchema, page);
  if (after) await requireConversation(workspaceId, after);
  if (assignee === 'me' && !viewerId) throw new AppError('Sign in to see chats assigned to you', 401, 'UNAUTHENTICATED');
  const rows = await prisma.conversation.findMany({
    ...query,
    where: {
      workspaceId,
      ...(labelId ? { labels: { some: { labelId } } } : {}),
      ...(assignee === 'me'
        ? { assignedTo: { userId: viewerId } }
        : assignee
          ? { assignedToId: assignee === 'unassigned' ? null : assignee }
          : {}),
      ...(status ? { status } : {}),
    },
    take: first + 1,
    ...(after ? { cursor: { id: after }, skip: 1 } : {}),
  });
  return toPage(rows, first);
}

// Every lookup is scoped to the caller's workspace, so other workspaces' data reads as "not found"
export async function requireConversation(workspaceId: string, id: string) {
  const conversation = await prisma.conversation.findFirst({ where: { id, workspaceId }, include: { contact: true } });
  if (!conversation) throw notFound('Conversation');
  return conversation;
}

export async function markConversationRead(workspaceId: string, id: string) {
  await requireConversation(workspaceId, id);
  return prisma.conversation.update({ where: { id }, data: { unread: 0 }, include: conversationInclude });
}

// Newest page first; `after` walks back to older messages. Nodes are returned oldest -> newest.
// `hideBefore`: the viewer cleared this chat at that time, so older messages are left out for them
export async function listMessages(workspaceId: string, conversationId: string, page: unknown, hideBefore?: Date | null) {
  await requireConversation(workspaceId, conversationId);
  const { first, after } = parse(pageSchema, page);
  if (after) {
    const cursor = await prisma.message.findFirst({ where: { id: after, conversationId } });
    if (!cursor) throw notFound('Message');
  }
  const rows = await prisma.message.findMany({
    where: { conversationId, ...(hideBefore ? { createdAt: { gt: hideBefore } } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: first + 1,
    ...(after ? { cursor: { id: after }, skip: 1 } : {}),
  });
  const result = toPage(rows, first);
  return { ...result, nodes: result.nodes.reverse() };
}

// REST: GET /inbox/conversations/:id/messages (marks read, returns full history)
export async function openConversation(workspaceId: string, id: string) {
  const conversation = await requireConversation(workspaceId, id);
  await prisma.conversation.update({ where: { id }, data: { unread: 0 } });
  const messages = await prisma.message.findMany({ where: { conversationId: id }, orderBy: { createdAt: 'asc' } });
  return { conversation, messages };
}

export const sendSchema = z.union([
  z.object({ type: z.literal('text'), body: z.string().min(1).max(4096) }),
  // language: omit to use the one the template is approved in
  z.object({ type: z.literal('template'), name: z.string().min(1), language: z.string().min(1).optional() }),
]);

async function requireAccount(workspaceId: string) {
  const account = await prisma.whatsAppAccount.findUnique({ where: { workspaceId } });
  if (!account) throw new AppError('Connect a WhatsApp number in Settings first', 400, 'WHATSAPP_NOT_CONNECTED');
  return account;
}

// Approved templates of the workspace's number, straight from Meta (nothing cached or stored)
export async function listMessageTemplates(workspaceId: string) {
  const account = await requireAccount(workspaceId);
  try {
    return await listApprovedTemplates(account);
  } catch (err) {
    throw new AppError(`Couldn't load templates from WhatsApp: ${(err as Error).message}`, 502, 'WHATSAPP_API_ERROR');
  }
}

// Each language of a template is approved separately; sending one that isn't approved fails at Meta.
// If Meta can't be asked right now, send as requested (or 'en') and let Meta's reply decide.
async function templateLanguage(account: { wabaId: string; accessToken: string }, name: string, requested?: string) {
  let approved;
  try {
    approved = await listApprovedTemplates(account);
  } catch {
    return requested ?? 'en';
  }
  return pickTemplateLanguage(approved, name, requested);
}

export function pickTemplateLanguage(templates: ApprovedTemplate[], name: string, requested?: string) {
  const approved = templates.filter((t) => t.name === name);
  const languages = approved.map((t) => t.language).join(', ');
  if (!approved.length)
    throw new AppError(`"${name}" is not an approved template on this WhatsApp number`, 400, 'TEMPLATE_NOT_APPROVED');
  const chosen = requested ? approved.find((t) => t.language === requested) : approved.length === 1 ? approved[0] : null;
  if (!chosen)
    throw new AppError(
      requested
        ? `"${name}" is not approved in ${requested}. Approved: ${languages}`
        : `"${name}" is approved in several languages (${languages}). Choose one.`,
      400,
      'TEMPLATE_LANGUAGE',
    );
  if (chosen.needsParameters)
    throw new AppError(`"${name}" needs variables, which can't be filled in here yet`, 400, 'TEMPLATE_NEEDS_PARAMETERS');
  return chosen.language;
}

// `sentById` is the agent sending it; it decides who may edit or delete the message later
export async function sendMessage(workspaceId: string, conversationId: string, rawInput: unknown, sentById?: string) {
  const input = parse(sendSchema, rawInput);
  const conversation = await requireConversation(workspaceId, conversationId);
  const account = await requireAccount(workspaceId);

  if (conversation.status === 'closed')
    throw new AppError('This chat is closed. Reopen it to reply.', 409, 'CONVERSATION_CLOSED');

  const windowOpen = conversation.lastInboundAt && Date.now() - conversation.lastInboundAt.getTime() < DAY;
  if (input.type === 'text' && !windowOpen)
    throw new AppError('24-hour window closed. Send an approved template instead.', 400, 'WINDOW_CLOSED');

  // Chats started before numbers were validated may lack the country code; WhatsApp would send to the wrong number
  if (!isWhatsAppNumber(conversation.contact.waId))
    throw new AppError(
      `+${conversation.contact.waId} is not a valid WhatsApp number. Start a new chat with the full number including the country code.`,
      400,
      'INVALID_PHONE',
    );
  // New Leads: someone has to take the chat (Assign to Me) before anyone messages the customer
  if (!conversation.assignedToId)
    throw new AppError('Assign this chat to yourself before replying (New Leads → Assign to Me).', 409, 'NOT_ASSIGNED');
  const language = input.type === 'template' ? await templateLanguage(account, input.name, input.language) : undefined;

  const body = input.type === 'text' ? input.body : `[template] ${input.name}`;
  const message = await prisma.message.create({
    data: { conversationId, direction: 'out', type: input.type, body, status: 'pending', sentById },
  });

  let saved;
  try {
    const wamid =
      input.type === 'text'
        ? await sendText(account, conversation.contact.waId, input.body)
        : await sendTemplate(account, conversation.contact.waId, input.name, language);
    saved = await prisma.message.update({ where: { id: message.id }, data: { waMessageId: wamid, status: 'sent' } });
  } catch (err) {
    saved = await prisma.message.update({
      where: { id: message.id },
      data: { status: 'failed', error: (err as Error).message },
    });
  }
  await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });
  emitToWorkspace(workspaceId, 'message:new', { conversation, message: await withSender(saved) });
  return saved;
}

// International number without '+' (WhatsApp's wa_id), checked against real numbering plans
export const isWhatsAppNumber = (waId: string) => isValidPhoneNumber(`+${waId}`);

const startSchema = z.object({
  waId: z
    .string()
    .transform((v) => v.replace(/\D/g, ''))
    .pipe(
      z
        .string()
        .min(8, 'Enter the number with country code')
        .max(15, 'Number is too long')
        .refine(isWhatsAppNumber, 'Not a valid number. Include the country code, e.g. 971501234567 or 919876543210'),
    ),
  name: z.string().trim().max(191).optional().nullable(),
});

// Start a chat with a new number (first message must be a template)
export async function startConversation(workspaceId: string, rawInput: unknown) {
  const { waId, name } = parse(startSchema, rawInput);
  const contact = await prisma.contact.upsert({
    where: { workspaceId_waId: { workspaceId, waId } },
    update: {},
    create: { workspaceId, waId, name: name || null },
  });
  return prisma.conversation.upsert({
    where: { workspaceId_contactId: { workspaceId, contactId: contact.id } },
    update: {},
    create: { workspaceId, contactId: contact.id },
  });
}

const simulateSchema = z.object({
  waId: z.string().default('919999999999'),
  name: z.string().default('Test Customer'),
  body: z.string().min(1).max(4096).default('Hi, is my order shipped?'),
});

// Dev only: fake an incoming customer message without Meta
export async function simulateIncoming(workspaceId: string, rawInput: unknown) {
  if (env.isProd) throw new AppError('Not available in production', 403, 'FORBIDDEN');
  const { waId, name, body } = parse(simulateSchema, rawInput ?? {});
  await saveIncoming(workspaceId, { waId, name, type: 'text', body });
}
