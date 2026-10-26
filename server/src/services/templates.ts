import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AuthPayload } from '../auth.js';
import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import {
  createTemplate,
  deleteTemplate,
  editTemplate,
  listApprovedTemplates,
  listTemplates,
  sendTemplateWithValues,
  uploadMedia,
  uploadTemplateSample,
} from '../whatsapp.js';
import { previewOf, recordActivity } from './activity.js';
import { AppError, notFound } from './errors.js';
import { checkCanSend, checkFile, cleanFileName } from './inbox.js';
import { getPermissions, requireAdmin } from './permissions.js';
import { withSender } from './senders.js';
import { type TemplateInfo, type TemplateSpec, buildCreateComponents, buildSendComponents, renderTemplate, sendValuesSchema, templateSpecSchema } from './templateModel.js';
import { parse } from './validate.js';
import { logMessageSend } from './logging.js';

// WhatsApp templates: sending one with its values from a chat (any member who may write there), and managing the
// number's templates in Settings → Templates (owners/admins). Templates live at Meta; nothing is stored here
// except the messages sent.

async function requireAccount(workspaceId: string) {
  const account = await prisma.whatsAppAccount.findUnique({ where: { workspaceId } });
  if (!account) throw new AppError('Connect a WhatsApp number in Settings first', 400, 'WHATSAPP_NOT_CONNECTED');
  return account;
}
const metaError = (what: string, err: unknown) => new AppError(`${what}: ${(err as Error).message}`, 502, 'WHATSAPP_API_ERROR');
// The editor has many of Meta's rules: report every problem at once, not only the first
function parseSpec(raw: unknown) {
  const r = templateSpecSchema.safeParse(raw ?? {});
  if (!r.success) throw new AppError([...new Set(r.error.issues.map((i) => i.message))].join(' · '), 400, 'BAD_USER_INPUT');
  return r.data;
}

// --- Sending from a chat

export async function approvedTemplates(auth: AuthPayload) {
  await getPermissions(auth);
  const account = await requireAccount(auth.workspaceId);
  try {
    return await listApprovedTemplates(account);
  } catch (err) {
    throw metaError("Couldn't load templates from WhatsApp", err);
  }
}

const VIDEO_MAX_BYTES = 16 * 1024 * 1024; // WhatsApp's limit for video
// The header file must match the template's header: an image (JPEG/PNG), an MP4 video or a document
function checkHeaderFile(format: string, bytes: Buffer | undefined, mime: string | undefined) {
  if (format === 'IMAGE') return checkFile(bytes, mime, 'image');
  if (format === 'DOCUMENT') return checkFile(bytes, mime, 'document');
  const type = (mime ?? '').toLowerCase().split(';')[0].trim();
  if (type !== 'video/mp4') throw new AppError('The header video must be an MP4 file', 415, 'UNSUPPORTED_MEDIA');
  if (!bytes?.length) throw new AppError('The file is empty', 400, 'BAD_USER_INPUT');
  if (bytes.length > VIDEO_MAX_BYTES) throw new AppError('Videos can be up to 16 MB', 413, 'TOO_LARGE');
  if (bytes.subarray(4, 8).toString('latin1') !== 'ftyp') throw new AppError("That file isn't a valid MP4 video", 415, 'UNSUPPORTED_MEDIA');
  return { mime: type, ext: 'mp4' };
}

const sendSchema = z.object({
  conversationId: z.string().min(1),
  name: z.string().min(1, 'Choose a template'),
  language: z.string().min(1).optional(),
  values: sendValuesSchema.default({ header: {}, body: {}, buttons: {} }),
});

// --- Manual sending only. A template goes to a customer only when a signed-in team member confirmed it in the chat
// ("Yes, Send"): the request must say confirmed: true and carry the requestId made for that one confirmation.
// Nothing in the app sends templates by itself (automations send text replies only). The same requestId again
// (a double click, a retried request) returns the first result instead of sending twice, and the same template
// can't be sent to the same chat twice at once.
const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
const REMEMBER_MS = 10 * 60_000;
const confirmedSends = new Map<string, { at: number; result: Promise<Awaited<ReturnType<typeof sendApprovedTemplate>>> }>();
const sendsInFlight = new Set<string>();

export async function sendTemplateMessage(auth: AuthPayload, rawInput: unknown, file?: { bytes?: Buffer; mime?: string; name?: string }) {
  const raw = (rawInput ?? {}) as { confirmed?: unknown; requestId?: unknown; conversationId?: unknown; name?: unknown };
  if (raw.confirmed !== true || typeof raw.requestId !== 'string' || !REQUEST_ID.test(raw.requestId))
    throw new AppError('Templates are sent only after you confirm them in the chat ("Yes, Send")', 400, 'CONFIRMATION_REQUIRED');
  const now = Date.now();
  for (const [k, v] of confirmedSends) if (now - v.at > REMEMBER_MS) confirmedSends.delete(k);
  const key = `${auth.workspaceId}:${auth.userId}:${raw.requestId}`;
  const earlier = confirmedSends.get(key);
  if (earlier) return earlier.result;
  const lock = `${auth.workspaceId}:${String(raw.conversationId)}:${String(raw.name)}`;
  if (sendsInFlight.has(lock)) throw new AppError('This template is already being sent to this chat', 409, 'DUPLICATE_SEND');
  sendsInFlight.add(lock);
  const result = sendApprovedTemplate(auth, rawInput, file).finally(() => sendsInFlight.delete(lock));
  confirmedSends.set(key, { at: now, result });
  result.catch(() => confirmedSends.delete(key)); // refused before sending (e.g. a value missing): may be fixed and confirmed again
  return result;
}

// Sends an approved template with its values (and its header file, if it has an image/video/document header).
// The chat shows the text with the values filled in (and the header file); WhatsApp delivers the real template.
async function sendApprovedTemplate(auth: AuthPayload, rawInput: unknown, file?: { bytes?: Buffer; mime?: string; name?: string }) {
  const input = parse(sendSchema, rawInput ?? {});
  await getPermissions(auth);
  // Templates may be sent outside WhatsApp's 24-hour window (that's what they're for)
  const { conversation, account } = await checkCanSend(auth.workspaceId, input.conversationId, auth.userId, false);
  let all: TemplateInfo[];
  try {
    all = await listApprovedTemplates(account);
  } catch (err) {
    throw metaError("Couldn't check the template with WhatsApp", err);
  }
  const matches = all.filter((t) => t.name === input.name);
  const t = input.language ? matches.find((m) => m.language === input.language) : matches.length === 1 ? matches[0] : undefined;
  if (!matches.length) throw new AppError(`“${input.name}” is not an approved template on this WhatsApp number`, 400, 'TEMPLATE_NOT_APPROVED');
  if (!t) throw new AppError(`Choose the language of “${input.name}” (${matches.map((m) => m.language).join(', ')})`, 400, 'TEMPLATE_LANGUAGE');
  if (!t.sendable) throw new AppError(t.unsupportedReason ?? "This template can't be sent from here", 400, 'TEMPLATE_UNSUPPORTED');

  const mediaHeader = t.header && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(t.header.format) ? t.header.format : null;
  const header = mediaHeader ? checkHeaderFile(mediaHeader, file?.bytes, file?.mime) : null;
  const fileName = mediaHeader === 'DOCUMENT' ? cleanFileName(file?.name, header!.ext) : null;
  // Values are checked (all filled in) before anything is stored or sent
  buildSendComponents(t, input.values, mediaHeader ? { id: 'check' } : undefined);
  const text = renderTemplate(t, input.values);
  const type = mediaHeader === 'IMAGE' ? 'image' : mediaHeader === 'VIDEO' ? 'video' : mediaHeader === 'DOCUMENT' ? 'document' : 'template';

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: 'out',
      type,
      body: text,
      status: 'pending',
      sentById: auth.userId,
      ...(header ? { mediaMime: header.mime, mediaSize: file!.bytes!.length, mediaName: fileName } : {}),
    },
  });
  if (header) {
    const relative = path.join(auth.workspaceId, `${message.id}.${header.ext}`);
    await mkdir(path.join(env.uploadsDir, auth.workspaceId), { recursive: true });
    await writeFile(path.join(env.uploadsDir, relative), file!.bytes!);
    await prisma.message.update({ where: { id: message.id }, data: { mediaPath: relative } });
  }
  let saved;
  let sendError: unknown;
  try {
    const media = header ? { id: await uploadMedia(account, file!.bytes!, header.mime, fileName ?? `${message.id}.${header.ext}`), ...(fileName ? { filename: fileName } : {}) } : undefined;
    const wamid = await sendTemplateWithValues(account, conversation.contact.waId, t.name, t.language, buildSendComponents(t, input.values, media));
    saved = await prisma.message.update({ where: { id: message.id }, data: { waMessageId: wamid, status: 'sent' } });
  } catch (err) {
    saved = await prisma.message.update({ where: { id: message.id }, data: { status: 'failed', error: (err as Error).message } });
    sendError = err;
  }
  logMessageSend({ workspaceId: auth.workspaceId, conversationId: conversation.id, messageId: message.id, type: 'template', userId: auth.userId, error: sendError, waMessageId: saved.waMessageId });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date(), updatedBy: auth.userId } });
  emitToWorkspace(auth.workspaceId, 'message:new', { conversation, message: await withSender(saved) });
  await recordActivity({
    workspaceId: auth.workspaceId,
    conversationId: conversation.id,
    actorId: auth.userId,
    type: 'message_sent',
    data: { preview: previewOf(`[Template ${t.name}] ${text}`, 200), messageType: 'template', status: saved.status },
  });
  return saved;
}

// --- Settings → Templates (owners/admins)

export async function allTemplates(auth: AuthPayload) {
  await requireAdmin(auth);
  const account = await requireAccount(auth.workspaceId);
  try {
    return await listTemplates(account);
  } catch (err) {
    throw metaError("Couldn't load templates from WhatsApp", err);
  }
}

// The sample file Meta needs for a media header (through the Meta app; needs META_APP_ID)
async function headerHandle(spec: TemplateSpec, accessToken: string, file?: { bytes?: Buffer; mime?: string; name?: string }) {
  if (!spec.header || spec.header.format === 'TEXT' || spec.category === 'AUTHENTICATION') return undefined;
  if (!env.metaAppId)
    throw new AppError(
      'Templates with an image, video or document header need the Meta app id (META_APP_ID in the server settings) to upload the sample file. Use a text header, or ask your administrator to set it.',
      400,
      'META_APP_ID_MISSING',
    );
  const checked = checkHeaderFile(spec.header.format, file?.bytes, file?.mime);
  try {
    return await uploadTemplateSample(env.metaAppId, accessToken, file!.bytes!, checked.mime, cleanFileName(file?.name, checked.ext));
  } catch (err) {
    throw metaError("Couldn't upload the sample file to WhatsApp", err);
  }
}

export async function createMessageTemplate(auth: AuthPayload, rawSpec: unknown, file?: { bytes?: Buffer; mime?: string; name?: string }) {
  await requireAdmin(auth);
  const spec = parseSpec(rawSpec);
  const account = await requireAccount(auth.workspaceId);
  const components = buildCreateComponents(spec, await headerHandle(spec, account.accessToken, file));
  try {
    const created = await createTemplate(account, { name: spec.name, language: spec.language, category: spec.category, components });
    emitToWorkspace(auth.workspaceId, 'templates:changed', {});
    return created;
  } catch (err) {
    throw metaError("WhatsApp didn't accept the template", err);
  }
}

export async function updateMessageTemplate(auth: AuthPayload, templateId: string, rawSpec: unknown, file?: { bytes?: Buffer; mime?: string; name?: string }) {
  await requireAdmin(auth);
  const spec = parseSpec(rawSpec);
  const account = await requireAccount(auth.workspaceId);
  const current = (await allTemplates(auth)).find((t) => t.id === templateId);
  if (!current) throw notFound('Template');
  if (current.name !== spec.name || current.language !== spec.language)
    throw new AppError("A template's name and language can't be changed; create a new one instead", 400, 'BAD_USER_INPUT');
  const components = buildCreateComponents(spec, await headerHandle(spec, account.accessToken, file));
  try {
    await editTemplate(account, templateId, { ...(current.status !== 'APPROVED' ? { category: spec.category } : {}), components });
  } catch (err) {
    throw metaError("WhatsApp didn't accept the change", err);
  }
  emitToWorkspace(auth.workspaceId, 'templates:changed', {});
  return true;
}

export async function deleteMessageTemplate(auth: AuthPayload, name: string, templateId?: string | null) {
  await requireAdmin(auth);
  const account = await requireAccount(auth.workspaceId);
  try {
    await deleteTemplate(account, name, templateId ?? undefined);
  } catch (err) {
    throw metaError("WhatsApp didn't delete the template", err);
  }
  emitToWorkspace(auth.workspaceId, 'templates:changed', {});
  return true;
}
