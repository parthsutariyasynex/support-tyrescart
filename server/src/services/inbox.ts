import { z } from 'zod';
import { env } from '../env.js';
import { saveIncoming } from '../messages.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { sendTemplate, sendText } from '../whatsapp.js';
import { AppError, notFound } from './errors.js';
import { parse } from './validate.js';

const DAY = 24 * 60 * 60 * 1000;
export const MAX_PAGE_SIZE = 100;

const pageSchema = z.object({
  first: z.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  after: z.string().min(1).optional(),
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
};

// Newest first. Omit `page` to get every conversation (REST behaviour).
export async function listConversations(workspaceId: string, page?: unknown) {
  const query = {
    where: { workspaceId },
    orderBy: [{ lastMessageAt: 'desc' as const }, { id: 'desc' as const }],
    include: conversationInclude,
  };
  if (page === undefined) return prisma.conversation.findMany(query);

  const { first, after } = parse(pageSchema, page);
  if (after) await requireConversation(workspaceId, after);
  const rows = await prisma.conversation.findMany({
    ...query,
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
export async function listMessages(workspaceId: string, conversationId: string, page: unknown) {
  await requireConversation(workspaceId, conversationId);
  const { first, after } = parse(pageSchema, page);
  if (after) {
    const cursor = await prisma.message.findFirst({ where: { id: after, conversationId } });
    if (!cursor) throw notFound('Message');
  }
  const rows = await prisma.message.findMany({
    where: { conversationId },
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
  z.object({ type: z.literal('template'), name: z.string().min(1), language: z.string().default('en') }),
]);

export async function sendMessage(workspaceId: string, conversationId: string, rawInput: unknown) {
  const input = parse(sendSchema, rawInput);
  const conversation = await requireConversation(workspaceId, conversationId);
  const account = await prisma.whatsAppAccount.findUnique({ where: { workspaceId } });
  if (!account) throw new AppError('Connect a WhatsApp number in Settings first', 400, 'WHATSAPP_NOT_CONNECTED');

  const windowOpen = conversation.lastInboundAt && Date.now() - conversation.lastInboundAt.getTime() < DAY;
  if (input.type === 'text' && !windowOpen)
    throw new AppError('24-hour window closed. Send an approved template instead.', 400, 'WINDOW_CLOSED');

  const body = input.type === 'text' ? input.body : `[template] ${input.name}`;
  const message = await prisma.message.create({
    data: { conversationId, direction: 'out', type: input.type, body, status: 'pending' },
  });

  let saved;
  try {
    const wamid =
      input.type === 'text'
        ? await sendText(account, conversation.contact.waId, input.body)
        : await sendTemplate(account, conversation.contact.waId, input.name, input.language);
    saved = await prisma.message.update({ where: { id: message.id }, data: { waMessageId: wamid, status: 'sent' } });
  } catch (err) {
    saved = await prisma.message.update({
      where: { id: message.id },
      data: { status: 'failed', error: (err as Error).message },
    });
  }
  await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });
  emitToWorkspace(workspaceId, 'message:new', { conversation, message: saved });
  return saved;
}

const startSchema = z.object({
  waId: z
    .string()
    .transform((v) => v.replace(/\D/g, ''))
    .pipe(z.string().min(8, 'Enter the number with country code').max(15, 'Number is too long')),
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
