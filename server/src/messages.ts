import { prisma } from './prisma.js';
import { wakeOnCustomerMessage } from './services/conversationStatus.js';
import { emitToWorkspace } from './realtime.js';
import { previewOf, recordActivity } from './services/activity.js';
import { withSender } from './services/senders.js';
import { cleanIncomingName, cleanMime, fetchIncomingMedia } from './services/incomingMedia.js';
import { defaultStageValue } from './services/leadStages.js';
import { runAutomations } from './services/automations.js';
import { inboundSentAt, laterOf } from './services/messagingWindow.js';
import { fitText, logEvent } from './services/logging.js';
import { locationBody, placeFromWebhook } from './services/locationFormat.js';

// Meta's explanation for a message it couldn't deliver as a normal type (e.g. type "unsupported", code 131051)
export type ProviderError = { code?: number; title?: string; error_data?: { details?: string } };

type Incoming = {
  waId: string;
  name?: string;
  waMessageId?: string;
  type: string;
  body: string;
  bsuid?: string;
  username?: string;
  // Photos, videos, voice notes, audio, documents, stickers: WhatsApp's media id (downloaded after saving)
  media?: { id: string; mime?: string; filename?: string };
  // The customer replied to (quoted) this message: its WhatsApp id
  replyToWaId?: string;
  // When the customer sent it (Meta's webhook timestamp); the 24-hour window runs from here
  sentAt?: Date;
  // Meta's errors on the message, as sent (only when there are some)
  errors?: ProviderError[];
};

// Fits the log's 500-character column
const PROVIDER_ERROR_MAX = 500;

// One of Meta's errors in words: "title: details" (or whichever is there); undefined when it has neither
export function describeProviderError(err: ProviderError | null | undefined): string | undefined {
  const title = typeof err?.title === 'string' ? err.title.trim() : '';
  const details = typeof err?.error_data?.details === 'string' ? err.error_data.details.trim() : '';
  if (!title && !details) return undefined;
  return fitText(title && details ? `${title}: ${details}` : title || details, PROVIDER_ERROR_MAX);
}

// Optional chaining throughout: Meta's webhook normally matches `msg.type` exactly, but a malformed or
// unexpected payload (a Meta API quirk, a future message shape) must degrade to a placeholder like the
// default case below, never throw - one bad message must never take the rest of the batch down with it
// (see the per-message try/catch in the webhook route).
const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'];

export function describe(msg: any): { type: string; body: string; media?: Incoming['media'] } {
  // Media: the caption is the text (or a placeholder like "[image]"); a voice note is audio marked "voice"
  if (MEDIA_TYPES.includes(msg?.type)) {
    const m = msg[msg.type] ?? {};
    const type = msg.type === 'audio' && m.voice ? 'voice' : msg.type;
    const caption = typeof m.caption === 'string' && m.caption.trim() ? m.caption : `[${msg.type}]`;
    return {
      type,
      body: caption,
      ...(typeof m.id === 'string' && m.id
        ? { media: { id: m.id, ...(typeof m.mime_type === 'string' ? { mime: m.mime_type } : {}), ...(typeof m.filename === 'string' ? { filename: m.filename } : {}) } }
        : {}),
    };
  }
  switch (msg.type) {
    case 'text':
      return { type: 'text', body: msg.text?.body ?? '[text]' };
    case 'button':
      return { type: 'button', body: msg.button?.text ?? '[button]' };
    case 'interactive':
      return {
        type: 'interactive',
        body: msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? '[interactive]',
      };
    case 'location': {
      // A pin the customer sent: its coordinates, and the place's name/address when they picked one
      const place = placeFromWebhook(msg.location);
      return { type: 'location', body: place ? locationBody(place) : '[location]' };
    }
    case 'unsupported':
      // Live location isn't available to businesses on WhatsApp's API: it arrives as an unsupported "location"
      return msg.unsupported?.type === 'location' ? { type: 'location', body: '[live location]' } : { type: 'unsupported', body: '[unsupported]' };
    default:
      // location, contacts, reaction...: a placeholder
      return { type: msg.type, body: `[${msg.type}]` };
  }
}

// Webhook "messages" that aren't something the customer wrote: Meta's own notices (system, e.g. the customer changed
// their number) and the "user opened the chat" signal (request_welcome). They don't open the 24-hour window, don't
// count as unread, don't trigger the auto-reply and don't show as chat bubbles.
const NOT_FROM_CUSTOMER = new Set(['system', 'request_welcome']);
export const isCustomerMessage = (msg: any) => !NOT_FROM_CUSTOMER.has(String(msg?.type ?? ''));

export function parseWebhookMessage(msg: any, contacts: any[] = []): Incoming {
  const contact = contacts.find((c) => c.wa_id === msg.from);
  // Business-scoped user ID and WhatsApp username: kept when Meta includes them (they're optional in the payload)
  const bsuid = typeof contact?.user_id === 'string' ? contact.user_id : undefined;
  const username = typeof contact?.profile?.username === 'string' ? contact.profile.username : undefined;
  // A reply quotes a message by its WhatsApp id (context.id); a forwarded message has a context without one
  const replyToWaId = typeof msg?.context?.id === 'string' ? msg.context.id : undefined;
  return {
    waId: msg.from,
    name: contact?.profile?.name,
    waMessageId: msg.id,
    ...describe(msg),
    ...(bsuid ? { bsuid } : {}),
    ...(username ? { username } : {}),
    ...(replyToWaId ? { replyToWaId } : {}),
    ...(msg?.timestamp !== undefined ? { sentAt: inboundSentAt(msg.timestamp) } : {}),
    ...(Array.isArray(msg?.errors) && msg.errors.length ? { errors: msg.errors } : {}),
  };
}

export async function saveIncoming(workspaceId: string, m: Incoming) {
  if (m.waMessageId && (await prisma.message.findUnique({ where: { waMessageId: m.waMessageId } })))
    return null; // Meta retries webhooks, so ignore duplicates

  const now = new Date();
  const contact = await prisma.contact.upsert({
    where: { workspaceId_waId: { workspaceId, waId: m.waId } },
    // A deleted contact who writes again comes back (Recently deleted contacts), so the message isn't lost
    update: { deletedAt: null, deletedBy: null, ...(m.name ? { name: m.name } : {}), ...(m.bsuid ? { waBsuid: m.bsuid } : {}), ...(m.username ? { waUsername: m.username } : {}) },
    // A new customer starts on the workspace's default lead stage
    create: { workspaceId, waId: m.waId, name: m.name, waBsuid: m.bsuid ?? null, waUsername: m.username ?? null, leadStage: await defaultStageValue(workspaceId) },
  });
  const existed = await prisma.conversation.findUnique({ where: { workspaceId_contactId: { workspaceId, contactId: contact.id } }, select: { id: true, lastInboundAt: true } });
  // The 24-hour window: from when the customer sent it (never moved back by a late retry of an older message)
  const lastInboundAt = laterOf(existed?.lastInboundAt, m.sentAt && m.sentAt <= now ? m.sentAt : now);
  const conversation = await prisma.conversation.upsert({
    where: { workspaceId_contactId: { workspaceId, contactId: contact.id } },
    update: { lastMessageAt: now, lastInboundAt, unread: { increment: 1 } },
    create: { workspaceId, contactId: contact.id, lastMessageAt: now, lastInboundAt, unread: 1 },
    include: { contact: true },
  });
  // A reply to a message of this chat is shown quoted (a message from before this app, or another chat, isn't)
  const quoted = m.replyToWaId ? await prisma.message.findFirst({ where: { waMessageId: m.replyToWaId, conversationId: conversation.id }, select: { id: true } }) : null;
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      waMessageId: m.waMessageId,
      replyToId: quoted?.id ?? null,
      direction: 'in',
      type: m.type,
      body: m.body,
      status: 'received',
      ...(m.media
        ? { waMediaId: m.media.id, mediaMime: m.media.mime ? cleanMime(m.media.mime) : null, mediaName: cleanIncomingName(m.media.filename) }
        : {}),
    },
  });
  // Logged without the customer's number or text; with Meta's error when it couldn't deliver the message normally
  const providerErrorCode = m.errors?.[0]?.code;
  const providerErrorMessage = describeProviderError(m.errors?.[0]);
  void logEvent({
    level: providerErrorCode !== undefined || providerErrorMessage ? 'WARNING' : 'SUCCESS',
    category: 'message',
    event: 'message.received',
    message: `Received a message (${m.type})${providerErrorMessage ? `. WhatsApp: ${providerErrorMessage}` : ''}`,
    workspaceId,
    errorCode: providerErrorCode ?? null,
    data: { conversationId: conversation.id, messageId: message.id, waMessageId: m.waMessageId ?? null, type: m.type, providerErrorCode: providerErrorCode ?? null, providerErrorMessage: providerErrorMessage ?? null },
  });
  // Fetch the file in the background (the webhook answers Meta right away); retried when someone opens it
  if (m.media) void fetchIncomingMedia(workspaceId, message.id).catch((err) => console.error('[media] download failed', message.id, (err as Error).message));
  emitToWorkspace(workspaceId, 'message:new', { conversation, message: await withSender(message) });
  // A brand-new chat: tell every connected member (toast). Only the customer's name, never the message text.
  if (!existed) emitToWorkspace(workspaceId, 'chat:new', { conversationId: conversation.id, contactName: conversation.contact.name || `+${conversation.contact.waId}` });
  // A snoozed chat wakes up as soon as the customer writes (closed chats stay closed)
  if (conversation.status === 'snoozed') await wakeOnCustomerMessage(conversation.id, workspaceId);
  await recordActivity({
    workspaceId,
    conversationId: conversation.id,
    actorId: null,
    type: 'message_received',
    data: { messageId: message.id, preview: previewOf(m.body, 100) },
  });
  // Simple automations (routing, auto-reply); they never stop the message from being saved
  await runAutomations(workspaceId, conversation.id).catch((err) => console.error('[automations] failed', conversation.id, (err as Error).message));
  return message;
}

const STATUS_RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

// Meta's delivery failures that come later in a status webhook (the send itself was accepted), explained for the logs
const KNOWN_FAILURES: Record<number, string> = {
  131047: 'More than 24 hours since the customer last wrote: only an approved template can be sent',
  131049: 'Meta chose not to deliver this message to maintain healthy ecosystem engagement (per-customer marketing limit); retrying right away will fail again',
  131026: "The customer's number can't receive it (not on WhatsApp, old app version, or hasn't accepted the terms)",
  131050: 'The customer stopped marketing messages from this business',
};

// Meta's error on a status update: its numeric code, title and details (only for failed statuses)
export function statusError(s: any): { code: number | null; title: string | null; details: string | null } | null {
  const e = s?.errors?.[0];
  if (!e) return null;
  const code = Number.isFinite(Number(e.code)) && e.code !== '' && e.code !== null ? Number(e.code) : null;
  const details = e.error_data?.details ?? e.message ?? null;
  return { code, title: typeof e.title === 'string' ? e.title : null, details: typeof details === 'string' ? details : null };
}

export async function applyStatus(workspaceId: string, s: any) {
  const message = await prisma.message.findUnique({ where: { waMessageId: s.id } });
  // Statuses can arrive out of order; never downgrade read -> delivered
  if (!message || (STATUS_RANK[s.status] ?? 0) <= (STATUS_RANK[message.status] ?? 0)) return;
  const updated = await prisma.message.update({
    where: { id: message.id },
    data: { status: s.status, error: s.errors?.[0]?.title },
  });
  emitToWorkspace(workspaceId, 'message:status', await withSender(updated));
  logStatus(workspaceId, message, s);
}

// One entry per status change of an outgoing message (sent → delivered → read, or failed with Meta's code)
function logStatus(workspaceId: string, message: { id: string; conversationId: string; status: string; type: string }, s: any) {
  const error = statusError(s);
  const data = { messageId: message.id, conversationId: message.conversationId, type: message.type, from: message.status, to: s.status };
  if (s.status !== 'failed') {
    void logEvent({ level: 'SUCCESS', category: 'message', event: 'message.status', message: `Message ${message.status} → ${s.status}`, workspaceId, data });
    return;
  }
  const known = error?.code !== null && error?.code !== undefined ? KNOWN_FAILURES[error.code] : undefined;
  void logEvent({
    level: 'ERROR',
    category: 'message',
    event: 'message.status',
    message: `WhatsApp didn't deliver a message: ${error?.title ?? 'no reason given'}${error?.code ? ` (${error.code})` : ''}${known ? `. ${known}` : ''}`,
    workspaceId,
    errorCode: error?.code ?? null,
    data: { ...data, title: error?.title, details: error?.details },
  });
}
