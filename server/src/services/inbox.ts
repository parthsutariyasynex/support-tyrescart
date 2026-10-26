import { isValidPhoneNumber } from 'libphonenumber-js/max';
import { z } from 'zod';
import { env } from '../env.js';
import { saveIncoming } from '../messages.js';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { isSupervisorOrAbove } from './roles.js';
import { emitToWorkspace } from '../realtime.js';
import { type ApprovedTemplate, listApprovedTemplates, sendAudio, sendDocument, sendImage, sendText, sendVideo, uploadMedia } from '../whatsapp.js';
import { windowOpen } from './messagingWindow.js';
import { prepareVoice } from './voice.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, notFound } from './errors.js';
import { previewOf, recordActivity } from './activity.js';
import { cleanIncomingName, fetchIncomingMedia, storeIncomingMedia } from './incomingMedia.js';
import { withSender } from './senders.js';
import { defaultStageValue } from './leadStages.js';
import { parse } from './validate.js';
import { logEvent, logFailure, logMessageSend, withMessageTrace } from './logging.js';

export const MAX_PAGE_SIZE = 100;

const pageSchema = z.object({
  first: z.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  after: z.string().min(1).optional(),
});

const conversationPageSchema = pageSchema.extend({
  labelId: z.string().min(1).optional(),
  assignee: z.string().min(1).optional(),
  status: z.enum(['open', 'snoozed', 'closed']).optional(),
  search: z.string().trim().max(100).optional(),
  // newest (default): latest activity first; oldest: least recent activity first
  sort: z.enum(['newest', 'oldest']).optional(),
  // "Filter by" menu: any of these labels; any of these assignees (member ids, or 'unassigned'); last activity range
  labelIds: z.array(z.string().min(1).max(64)).max(100).optional(),
  // Left menu → Lifecycle stages: only chats whose customer is at this stage (a stage's value)
  leadStage: z.string().trim().min(1).max(20).optional(),
  // "Filter by" menu → Stage: customer at any of these stages
  leadStages: z.array(z.string().trim().min(1).max(20)).max(100).optional(),
  assigneeIds: z.array(z.string().min(1).max(64)).max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

// Free-text search over a workspace's chats, one box for everything (case-insensitive, substring):
//   customer name · phone number (digits, so "+971 50" finds 97150…) · any message text (deleted ones excluded)
//   · label name · assignee name · the words open / closed / unread / assigned / unassigned (chat status)
export function conversationSearchWhere(raw: string): Prisma.ConversationWhereInput {
  const term = raw.trim();
  if (!term) return {};
  const word = term.toLowerCase();
  const digits = term.replace(/\D/g, '');
  const or: Prisma.ConversationWhereInput[] = [
    { contact: { name: { contains: term } } },
    ...(digits.length >= 3 ? [{ contact: { waId: { contains: digits } } }] : []),
    { messages: { some: { body: { contains: term }, deletedAt: null } } },
    { labels: { some: { label: { name: { contains: term } } } } },
    { assignedTo: { user: { name: { contains: term } } } },
  ];
  if (word === 'open' || word === 'closed') or.push({ status: word });
  if (word === 'unread') or.push({ unread: { gt: 0 } });
  if (word === 'unassigned') or.push({ assignedToId: null });
  if (word === 'assigned') or.push({ assignedToId: { not: null } });
  return { OR: or };
}

export type Page<T> = { nodes: T[]; hasNextPage: boolean; endCursor: string | null };

// Fetch one extra row to know whether another page exists
function toPage<T extends { id: string }>(rows: T[], first: number): Page<T> {
  const nodes = rows.slice(0, first);
  return { nodes, hasNextPage: rows.length > first, endCursor: nodes.at(-1)?.id ?? null };
}

// New Leads: open chats nobody holds right now, for someone to take. A chat that is unassigned (or whose assignee
// was removed) comes back here at once. Closed and snoozed chats aren't leads; chats of deleted contacts are left
// out like everywhere else.
export const NEW_LEAD_WHERE = {
  assignedToId: null,
  status: 'open',
} satisfies Prisma.ConversationWhereInput;

const conversationInclude = {
  contact: true,
  // Whether the chat was ever assigned (anything in its assignment history): New Leads leaves it out for good
  _count: { select: { assignments: true } },
  messages: { orderBy: { createdAt: 'desc' as const }, take: 1 },
  labels: { include: { label: true } },
  // The holding member, with the person's name for the assignee shape
  assignedTo: { include: { user: { select: { id: true, name: true } } } },
};

// Newest first. Omit `page` to get every conversation (REST behaviour).
// `labelId` keeps only conversations that have that label; `assignee` is a member id, 'unassigned', 'me'
// (assigned to `viewerId`'s membership) or 'new_leads' (NEW_LEAD_WHERE); `status` is 'open' or 'closed' (omit for both).
export async function listConversations(workspaceId: string, page?: unknown, viewerId?: string) {
  // Chats of deleted contacts (Settings → Recently deleted contacts) are left out everywhere
  const query = {
    where: { workspaceId, contact: { deletedAt: null } },
    orderBy: [{ lastMessageAt: 'desc' as const }, { id: 'desc' as const }],
    include: conversationInclude,
  };
  if (page === undefined) return prisma.conversation.findMany(query);

  const { first, after, labelId, assignee, status, search, sort, labelIds, assigneeIds, from, to, leadStage, leadStages } = parse(conversationPageSchema, page);
  if (from && to && from > to) throw new AppError('"from" must be before "to"', 400, 'BAD_USER_INPUT');
  const memberIds = (assigneeIds ?? []).filter((a) => a !== 'unassigned');
  const menuFilters: Prisma.ConversationWhereInput[] = [
    ...(labelIds?.length ? [{ labels: { some: { labelId: { in: labelIds } } } }] : []),
    ...(leadStages?.length ? [{ contact: { leadStage: { in: leadStages } } }] : []),
    ...(assigneeIds?.length
      ? [{ OR: [...(memberIds.length ? [{ assignedToId: { in: memberIds } }] : []), ...(assigneeIds.includes('unassigned') ? [{ assignedToId: null }] : [])] }]
      : []),
    ...(from || to ? [{ lastMessageAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }] : []),
  ];
  const dir = sort === 'oldest' ? ('asc' as const) : ('desc' as const);
  if (after) await requireConversation(workspaceId, after);
  if ((assignee === 'me' || assignee === 'collaborating' || assignee === 'mentioned') && !viewerId) throw new AppError('Sign in to see chats assigned to you', 401, 'UNAUTHENTICATED');
  // The viewer's pinned chats come first on the first page (whatever their age), and are left out of the pages
  const pins = viewerId
    ? (await prisma.conversationPin.findMany({ where: { userId: viewerId, conversation: { workspaceId } }, orderBy: { createdAt: 'desc' }, select: { conversationId: true } })).map((p) => p.conversationId)
    : [];
  const where: Prisma.ConversationWhereInput = {
      workspaceId,
      contact: { deletedAt: null, ...(leadStage ? { leadStage } : {}) },
      ...(labelId ? { labels: { some: { labelId } } } : {}),
      ...(assignee === 'collaborating'
        ? // Collaborations: chats I've been added to as a collaborator
          { collaborators: { some: { userId: viewerId } } }
        : assignee === 'mentioned'
        ? // Mentions: chats where someone @mentioned me in an internal note
          { activity: { some: { type: 'note_mention', data: { path: '$.mentionedUserId', equals: viewerId } } } }
        : assignee === 'me'
        ? // My Chats: assigned to me (chats I only collaborate on are in Collaborations)
          { assignedTo: { userId: viewerId } }
        : assignee === 'new_leads'
          ? NEW_LEAD_WHERE
          : assignee
            ? { assignedToId: assignee === 'unassigned' ? null : assignee }
            : {}),
      ...(status ? { status } : {}),
      ...(search ? conversationSearchWhere(search) : {}),
      ...(menuFilters.length ? { AND: menuFilters } : {}),
  };
  const rows = await prisma.conversation.findMany({
    ...query,
    orderBy: [{ lastMessageAt: dir }, { id: dir }],
    where: pins.length ? { AND: [where, { id: { notIn: pins } }] } : where,
    take: first + 1,
    ...(after ? { cursor: { id: after }, skip: 1 } : {}),
  });
  const page_ = toPage(rows, first);
  if (after || !pins.length) return page_;
  const pinned = await prisma.conversation.findMany({ ...query, where: { AND: [where, { id: { in: pins } }] } });
  pinned.sort((a, b) => pins.indexOf(a.id) - pins.indexOf(b.id));
  return { ...page_, nodes: [...pinned, ...page_.nodes] };
}

// Every lookup is scoped to the caller's workspace, so other workspaces' data reads as "not found"
export async function requireConversation(workspaceId: string, id: string) {
  // A deleted contact's chat can't be opened or used until the contact is restored
  const conversation = await prisma.conversation.findFirst({ where: { id, workspaceId, contact: { deletedAt: null } }, include: { contact: true } });
  if (!conversation) throw notFound('Conversation');
  return conversation;
}

export async function markConversationRead(workspaceId: string, id: string, viewerId: string | null = null) {
  const conversation = await requireConversation(workspaceId, id);
  return prisma.conversation.update({
    where: { id },
    data: { unread: 0, ...(viewerId ? { updatedBy: viewerId } : {}), ...(await openedByAssignee(conversation, viewerId)) },
    include: conversationInclude,
  });
}

// The viewer is the chat's current assignee and hasn't opened it since it was assigned to them: stamp it now
// (assignment reminders stop for this chat). Anyone else opening it changes nothing.
async function openedByAssignee(
  conversation: { assignedToId: string | null; assigneeOpenedAt: Date | null },
  viewerId: string | null,
): Promise<{ assigneeOpenedAt?: Date }> {
  if (!viewerId || !conversation.assignedToId || conversation.assigneeOpenedAt) return {};
  const own = await prisma.member.findFirst({ where: { id: conversation.assignedToId, userId: viewerId }, select: { id: true } });
  return own ? { assigneeOpenedAt: new Date() } : {};
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
export async function openConversation(workspaceId: string, id: string, viewerId: string | null = null) {
  const conversation = await requireConversation(workspaceId, id);
  await prisma.conversation.update({
    where: { id },
    data: { unread: 0, ...(viewerId ? { updatedBy: viewerId } : {}), ...(await openedByAssignee(conversation, viewerId)) },
  });
  const messages = await prisma.message.findMany({ where: { conversationId: id }, orderBy: { createdAt: 'asc' } });
  return { conversation, messages };
}

export const sendSchema = z.union([
  z.object({ type: z.literal('text'), body: z.string().min(1).max(4096), replyToId: z.string().min(1).nullish() }),
  // language: omit to use the one the template is approved in
  z.object({ type: z.literal('template'), name: z.string().min(1), language: z.string().min(1).optional() }),
]);

// The message a reply quotes: it must be in the same chat and not deleted. WhatsApp quotes it too when it has a
// WhatsApp id (a message that failed to send has none: the reply is still sent, quoted only in the app).
export async function replyTarget(conversationId: string, replyToId: unknown) {
  if (replyToId === undefined || replyToId === null || replyToId === '') return null;
  if (typeof replyToId !== 'string') throw new AppError('Choose the message to reply to', 400, 'BAD_USER_INPUT');
  const target = await prisma.message.findFirst({ where: { id: replyToId, conversationId }, select: { id: true, waMessageId: true, deletedAt: true } });
  if (!target) throw new AppError("The message you're replying to isn't in this chat", 400, 'BAD_USER_INPUT');
  if (target.deletedAt) throw new AppError("You can't reply to a deleted message", 400, 'BAD_USER_INPUT');
  return target;
}

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
export function pickTemplateLanguage(templates: Pick<ApprovedTemplate, 'name' | 'language' | 'needsParameters'>[], name: string, requested?: string) {
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

// Everything that must be true before your team sends the customer anything (text, image or template)
export async function checkCanSend(workspaceId: string, conversationId: string, sentById: string | undefined, freeForm: boolean) {
  const conversation = await requireConversation(workspaceId, conversationId);
  const account = await requireAccount(workspaceId);

  if (conversation.status === 'closed')
    throw new AppError('This chat is closed. Reopen it to reply.', 409, 'CONVERSATION_CLOSED');

  // Free-form messages (text, images) only within 24 hours of the customer's last message; templates any time
  if (freeForm && !windowOpen(conversation.lastInboundAt))
    throw new AppError('24-hour window closed. Send an approved template instead.', 400, 'WINDOW_CLOSED');

  // Chats started before numbers were validated may lack the country code; WhatsApp would send to the wrong number
  if (!isWhatsAppNumber(conversation.contact.waId))
    throw new AppError(
      `+${conversation.contact.waId} is not a valid WhatsApp number. Start a new chat with the full number including the country code.`,
      400,
      'INVALID_PHONE',
    );
  // New Leads: an agent has to take the chat (Assign to Me) before messaging the customer. Owners, admins and
  // supervisors may reply to a chat nobody holds yet (replying doesn't assign it).
  if (!conversation.assignedToId) {
    const sender = sentById ? await prisma.member.findUnique({ where: { userId_workspaceId: { userId: sentById, workspaceId } }, select: { role: true } }) : null;
    if (!sender || !isSupervisorOrAbove(sender.role))
      throw new AppError('Assign this chat to yourself before replying (New Leads → Assign to Me).', 409, 'NOT_ASSIGNED');
  }
  return { conversation, account };
}

// --- Images, videos and documents

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // WhatsApp's limit for images
export const VIDEO_MAX_BYTES = 16 * 1024 * 1024; // WhatsApp's limit for video
export const DOCUMENT_MAX_BYTES = 100 * 1024 * 1024; // WhatsApp's limit for documents
export const CAPTION_MAX = 1024;
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // old Office files (.doc .xls .ppt)
const ZIP = [0x50, 0x4b, 0x03, 0x04]; // new Office files (.docx .xlsx .pptx) are zip files
// What can be sent, checked from the file's first bytes (not just the type the browser reports)
type FileKind = 'image' | 'video' | 'document';
const FILE_TYPES: Record<string, { kind: FileKind; ext: string; magic: number[] | 'text' | 'ftyp' }> = {
  'image/jpeg': { kind: 'image', ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
  'image/png': { kind: 'image', ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // MP4 and 3GP share the ISO media layout: "ftyp" at byte 4. WhatsApp plays H.264 video with AAC audio.
  'video/mp4': { kind: 'video', ext: 'mp4', magic: 'ftyp' },
  'video/3gpp': { kind: 'video', ext: '3gp', magic: 'ftyp' },
  'application/pdf': { kind: 'document', ext: 'pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  'application/msword': { kind: 'document', ext: 'doc', magic: OLE },
  'application/vnd.ms-excel': { kind: 'document', ext: 'xls', magic: OLE },
  'application/vnd.ms-powerpoint': { kind: 'document', ext: 'ppt', magic: OLE },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: 'document', ext: 'docx', magic: ZIP },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'document', ext: 'xlsx', magic: ZIP },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { kind: 'document', ext: 'pptx', magic: ZIP },
  'text/plain': { kind: 'document', ext: 'txt', magic: 'text' },
};

// The bytes must really be the kind of file they claim to be. Returns the type, its kind and extension.
const KIND_RULES: Record<FileKind, { max: number; tooLarge: string; unsupported: string }> = {
  image: { max: IMAGE_MAX_BYTES, tooLarge: 'Images can be up to 5 MB', unsupported: 'Only JPEG and PNG images can be sent' },
  video: { max: VIDEO_MAX_BYTES, tooLarge: 'Videos can be up to 16 MB', unsupported: 'Only MP4 and 3GP videos can be sent' },
  document: { max: DOCUMENT_MAX_BYTES, tooLarge: 'Documents can be up to 100 MB', unsupported: 'Only PDF, Word, Excel, PowerPoint and text files can be sent' },
};
export function checkFile(bytes: Buffer | undefined, mime: string | undefined, kind: FileKind) {
  const type = (mime ?? '').toLowerCase().split(';')[0].trim();
  const spec = FILE_TYPES[type];
  const rules = KIND_RULES[kind];
  if (!spec || spec.kind !== kind) throw new AppError(rules.unsupported, 415, 'UNSUPPORTED_MEDIA');
  if (!bytes?.length) throw new AppError('The file is empty', 400, 'BAD_USER_INPUT');
  if (bytes.length > rules.max) throw new AppError(rules.tooLarge, 413, 'TOO_LARGE');
  const valid =
    spec.magic === 'text'
      ? !bytes.subarray(0, 8192).includes(0) // plain text has no NUL bytes
      : spec.magic === 'ftyp'
        ? bytes.subarray(4, 8).toString('latin1') === 'ftyp'
        : spec.magic.every((b, i) => bytes[i] === b);
  if (!valid) throw new AppError(`That file isn't a valid ${spec.ext.toUpperCase()} file`, 415, 'UNSUPPORTED_MEDIA');
  return { mime: type, ext: spec.ext };
}
// Kept for callers/tests that only handle images
export const checkImage = (bytes: Buffer | undefined, mime: string | undefined) => checkFile(bytes, mime, 'image');

// A safe file name to show and send: no folders or control characters, at most 200 characters, right extension
export function cleanFileName(raw: unknown, ext: string) {
  const base = (typeof raw === 'string' ? raw : '').replace(/[\\/\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  const name = base || `document.${ext}`;
  return name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`;
}

// Sends an image, a video or a document (optional caption): a copy is kept on the server so the app can show or download it,
// then it's uploaded to WhatsApp and sent. A WhatsApp failure is kept as a failed message (like text), not lost.
export async function sendMediaMessage(
  kind: FileKind | 'voice',
  workspaceId: string,
  conversationId: string,
  bytes: Buffer | undefined,
  mime: string | undefined,
  rawCaption: unknown,
  rawName: unknown,
  sentById?: string,
  replyToId?: unknown,
) {
  // Voice notes are checked (and WebM repackaged to OGG/Opus) by prepareVoice; everything else by checkFile
  const voice = kind === 'voice' ? prepareVoice(bytes, mime) : null;
  const file = voice ?? checkFile(bytes, mime, kind as FileKind);
  const data = voice ? voice.bytes : bytes!;
  const caption = kind === 'voice' ? '' : typeof rawCaption === 'string' ? rawCaption.trim() : '';
  if (caption.length > CAPTION_MAX) throw new AppError(`Caption is too long (max ${CAPTION_MAX} characters)`, 400, 'BAD_USER_INPUT');
  const fileName = kind === 'document' ? cleanFileName(rawName, file.ext) : null;
  const { conversation, account } = await checkCanSend(workspaceId, conversationId, sentById, true);
  const quoted = await replyTarget(conversationId, replyToId);

  const message = await prisma.message.create({
    data: { conversationId, direction: 'out', type: kind, body: caption, status: 'pending', sentById, mediaMime: file.mime, mediaSize: data.length, mediaName: fileName, replyToId: quoted?.id ?? null },
  });
  const relative = path.join(workspaceId, `${message.id}.${file.ext}`);
  await mkdir(path.join(env.uploadsDir, workspaceId), { recursive: true });
  await writeFile(path.join(env.uploadsDir, relative), data);
  await prisma.message.update({ where: { id: message.id }, data: { mediaPath: relative } });

  let saved;
  let sendError: unknown;
  try {
    // The upload and the send both name this message in the logs
    const wamid = await withMessageTrace({ messageId: message.id, conversationId }, async () => {
      const mediaId = await uploadMedia(account, data, file.mime, fileName ?? `${message.id}.${file.ext}`);
      return kind === 'image'
        ? sendImage(account, conversation.contact.waId, mediaId, caption || undefined, quoted?.waMessageId)
        : kind === 'video'
          ? sendVideo(account, conversation.contact.waId, mediaId, caption || undefined, quoted?.waMessageId)
          : kind === 'voice'
            ? sendAudio(account, conversation.contact.waId, mediaId, quoted?.waMessageId)
            : sendDocument(account, conversation.contact.waId, mediaId, fileName!, caption || undefined, quoted?.waMessageId);
    });
    saved = await prisma.message.update({ where: { id: message.id }, data: { waMessageId: wamid, status: 'sent' } });
  } catch (err) {
    saved = await prisma.message.update({ where: { id: message.id }, data: { status: 'failed', error: (err as Error).message } });
    sendError = err;
  }
  logMessageSend({ workspaceId, conversationId, messageId: message.id, type: kind, userId: sentById, error: sendError, waMessageId: saved.waMessageId, content: caption || null });
  await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date(), ...(sentById ? { updatedBy: sentById } : {}) } });
  emitToWorkspace(workspaceId, 'message:new', { conversation, message: await withSender(saved) });
  const label = kind === 'image' ? '[Photo]' : kind === 'video' ? '[Video]' : kind === 'voice' ? '[Voice message]' : `[Document] ${fileName}`;
  await recordActivity({
    workspaceId,
    conversationId,
    actorId: sentById ?? null,
    type: 'message_sent',
    data: { preview: caption ? previewOf(`${label} ${caption}`, 200) : label, messageType: kind, status: saved.status },
  });
  return saved;
}

export const sendImageMessage = (workspaceId: string, conversationId: string, bytes: Buffer | undefined, mime: string | undefined, rawCaption: unknown, sentById?: string) =>
  sendMediaMessage('image', workspaceId, conversationId, bytes, mime, rawCaption, null, sentById);

// The stored copy of an image or document message, for members of its workspace only
export async function readMessageMedia(workspaceId: string, messageId: string) {
  let message = await prisma.message.findFirst({
    where: { id: messageId, conversation: { workspaceId } },
    select: { mediaPath: true, mediaMime: true, mediaName: true, deletedAt: true, waMediaId: true },
  });
  // A customer's file that isn't downloaded yet (or failed before): try now
  if (message && !message.mediaPath && message.waMediaId && !message.deletedAt) {
    try {
      await fetchIncomingMedia(workspaceId, messageId);
    } catch (err) {
      throw new AppError(`Couldn't download this file from WhatsApp: ${(err as Error).message}`, 502, 'MEDIA_UNAVAILABLE');
    }
    message = await prisma.message.findFirst({
      where: { id: messageId, conversation: { workspaceId } },
      select: { mediaPath: true, mediaMime: true, mediaName: true, deletedAt: true, waMediaId: true },
    });
  }
  if (!message?.mediaPath || !message.mediaMime || message.deletedAt) throw notFound('File');
  const full = path.resolve(env.uploadsDir, message.mediaPath);
  if (!full.startsWith(env.uploadsDir + path.sep)) throw notFound('File'); // never outside the uploads folder
  try {
    return { bytes: await readFile(full), mime: message.mediaMime, name: message.mediaName };
  } catch (err) {
    void logFailure('file.missing', "A message's file is missing on the server", err, { level: 'WARNING', workspaceId, messageId });
    throw notFound('File');
  }
}

// `sentById` is the agent sending it; it decides who may edit or delete the message later
export async function sendMessage(workspaceId: string, conversationId: string, rawInput: unknown, sentById?: string) {
  // First step on the API's side, before any check: a refusal below (not assigned, window closed…) is logged by the
  // GraphQL layer with the same request id, so the reply's text and chat are in the logs either way
  const raw = rawInput as { body?: unknown; type?: unknown; replyToId?: unknown } | null;
  void logEvent({
    level: 'SUCCESS',
    category: 'message',
    event: 'message.send_requested',
    message: `Reply received by the API (${typeof raw?.type === 'string' ? raw.type : 'text'}), checking it can be sent`,
    direction: 'out',
    outcome: 'received',
    newStatus: 'requested',
    workspaceId,
    userId: sentById,
    conversationId,
    content: typeof raw?.body === 'string' ? raw.body : null,
    data: { type: typeof raw?.type === 'string' ? raw.type : null, replyToId: typeof raw?.replyToId === 'string' ? raw.replyToId : null },
  });
  const input = parse(sendSchema, rawInput);
  // Templates go only through sendTemplateMessage (the chat's "Yes, Send" confirmation), never through here
  if (input.type === 'template')
    throw new AppError('Templates are sent only after you confirm them in the chat ("Yes, Send")', 400, 'CONFIRMATION_REQUIRED');
  const { conversation, account } = await checkCanSend(workspaceId, conversationId, sentById, true);
  const quoted = await replyTarget(conversationId, input.replyToId);

  const body = input.body;
  const message = await prisma.message.create({
    data: { conversationId, direction: 'out', type: input.type, body, status: 'pending', sentById, replyToId: quoted?.id ?? null },
  });

  let saved;
  let sendError: unknown;
  try {
    const wamid = await withMessageTrace({ messageId: message.id, conversationId }, () => sendText(account, conversation.contact.waId, input.body, quoted?.waMessageId));
    saved = await prisma.message.update({ where: { id: message.id }, data: { waMessageId: wamid, status: 'sent' } });
  } catch (err) {
    saved = await prisma.message.update({
      where: { id: message.id },
      data: { status: 'failed', error: (err as Error).message },
    });
    sendError = err;
  }
  logMessageSend({ workspaceId, conversationId, messageId: message.id, type: input.type, userId: sentById, error: sendError, waMessageId: saved.waMessageId, content: body });
  await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date(), ...(sentById ? { updatedBy: sentById } : {}) } });
  emitToWorkspace(workspaceId, 'message:new', { conversation, message: await withSender(saved) });
  // Contact details page activity log: "Message sent by …" (not the chat timeline or the bell; the chat shows the bubble)
  await recordActivity({
    workspaceId,
    conversationId,
    actorId: sentById ?? null,
    type: 'message_sent',
    data: { preview: previewOf(body, 200), messageType: input.type, status: saved.status },
  });
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

// Start a chat with a number (the first message must be a template). The number is checked against real numbering
// plans and stored one way (digits with country code), so the same customer is never added twice: an existing
// contact and chat are reused (startedNow: false; a deleted contact comes back), and two people starting the same
// number at once get the same chat. A new chat appears in everyone's inbox at once (conversation:started).
export async function startConversation(workspaceId: string, rawInput: unknown, createdBy: string | null = null) {
  const { waId, name } = parse(startSchema, rawInput);
  const stage = await defaultStageValue(workspaceId);
  // Both rows are unique per workspace; a simultaneous start of the same number loses the race once and then reads
  // what the other one made
  let lostRace = false;
  const once = async <T>(write: () => Promise<T>, read: () => Promise<T | null>) => {
    try {
      return await write();
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
      const row = await read();
      if (!row) throw err;
      lostRace = true;
      return row;
    }
  };
  const contactKey = { workspaceId_waId: { workspaceId, waId } };
  const contact = await once(
    () =>
      prisma.contact.upsert({
        where: contactKey,
        update: { deletedAt: null, deletedBy: null }, // starting a chat with a deleted contact brings them back
        create: { workspaceId, waId, name: name || null, createdBy, leadStage: stage },
      }),
    () => prisma.contact.findUnique({ where: contactKey }),
  );
  const conversationKey = { workspaceId_contactId: { workspaceId, contactId: contact.id } };
  const existing = await prisma.conversation.findUnique({ where: conversationKey, select: { id: true } });
  const conversation = await once(
    () => prisma.conversation.upsert({ where: conversationKey, update: {}, create: { workspaceId, contactId: contact.id, createdBy } }),
    () => prisma.conversation.findUnique({ where: conversationKey }),
  );
  const startedNow = !existing && !lostRace;
  if (startedNow) emitToWorkspace(workspaceId, 'conversation:started', { conversationId: conversation.id, contactName: contact.name || `+${waId}` });
  return { ...conversation, startedNow };
}

const simulateSchema = z.object({
  waId: z.string().default('919999999999'),
  name: z.string().default('Test Customer'),
  body: z.string().min(1).max(4096).default('Hi, is my order shipped?'),
  // Dev/test: a file "sent by the customer" (stored straight away, no WhatsApp download)
  media: z
    .object({
      type: z.enum(['image', 'video', 'audio', 'voice', 'document', 'sticker']),
      mime: z.string().min(3).max(100),
      base64: z.string().min(1).max(14_000_000),
      filename: z.string().max(200).optional(),
      caption: z.string().max(1024).optional(),
    })
    .optional(),
});

// Dev only: fake an incoming customer message without Meta
export async function simulateIncoming(workspaceId: string, rawInput: unknown) {
  if (env.isProd) throw new AppError('Not available in production', 403, 'FORBIDDEN');
  const { waId, name, body, media } = parse(simulateSchema, rawInput ?? {});
  if (!media) {
    await saveIncoming(workspaceId, { waId, name, type: 'text', body });
    return;
  }
  const message = await saveIncoming(workspaceId, { waId, name, type: media.type, body: media.caption?.trim() || `[${media.type === 'voice' ? 'audio' : media.type}]` });
  if (!message) return;
  if (media.filename) await prisma.message.update({ where: { id: message.id }, data: { mediaName: cleanIncomingName(media.filename) } });
  await storeIncomingMedia(workspaceId, message.id, Buffer.from(media.base64, 'base64'), media.mime);
}
