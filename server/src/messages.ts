import { prisma } from './prisma.js';
import { wakeOnCustomerMessage } from './services/conversationStatus.js';
import { emitToWorkspace } from './realtime.js';
import { previewOf, recordActivity } from './services/activity.js';
import { withSender } from './services/senders.js';
import { cleanIncomingName, cleanMime, fetchIncomingMedia } from './services/incomingMedia.js';
import { defaultStageValue } from './services/leadStages.js';
import { runAutomations } from './services/automations.js';
import { pushCustomerMessage } from './services/push.js';
import { inboundSentAt, laterOf } from './services/messagingWindow.js';
import { errorCodeOf, errorDetailsOf, fitText, logEvent } from './services/logging.js';
import { explainMetaError } from './services/metaErrors.js';
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
  const duplicate = m.waMessageId ? await prisma.message.findUnique({ where: { waMessageId: m.waMessageId }, select: { id: true, conversationId: true } }) : null;
  if (duplicate) {
    // Meta retries webhooks: already saved, so nothing more to do (recorded, not silently dropped)
    void logEvent({ level: 'SUCCESS', category: 'message', event: 'message.duplicate', message: `Message already received (Meta sent it again), ignored`, direction: 'in', outcome: 'duplicate', workspaceId, messageId: duplicate.id, waMessageId: m.waMessageId, conversationId: duplicate.conversationId, data: { type: m.type }, fileOnly: true });
    return null;
  }

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
    direction: 'in',
    outcome: 'saved',
    previousStatus: null,
    newStatus: 'received',
    reason: existed ? "Meta's webhook delivered a customer's message in an existing chat" : "Meta's webhook delivered a message from a new customer (a new chat was created)",
    workspaceId,
    messageId: message.id,
    waMessageId: m.waMessageId ?? null,
    conversationId: conversation.id,
    // The customer's words, number and name (with LOG_CUSTOMER_DATA), and when they sent it by Meta's clock
    content: m.body,
    errorCode: providerErrorCode ?? null,
    errorDetails: providerErrorMessage ?? null,
    data: {
      type: m.type,
      from: m.waId,
      senderName: m.name ?? null,
      sentAt: m.sentAt && !Number.isNaN(m.sentAt.getTime()) ? m.sentAt.toISOString() : null,
      ...(m.replyToWaId ? { replyToWaMessageId: m.replyToWaId } : {}),
      ...(m.media ? { media: { mime: m.media.mime ?? null, filename: m.media.filename ?? null } } : {}),
      providerErrorCode: providerErrorCode ?? null,
      providerErrorMessage: providerErrorMessage ?? null,
    },
  });
  // Fetch the file in the background (the webhook answers Meta right away); retried when someone opens it
  if (m.media)
    void fetchIncomingMedia(workspaceId, message.id).catch((err) => {
      console.error('[media] download failed', message.id, (err as Error).message);
      void logEvent({ level: 'ERROR', category: 'message', event: 'message.media_failed', message: `Couldn't download the customer's file: ${(err as Error)?.message ?? err}`, direction: 'in', workspaceId, messageId: message.id, waMessageId: m.waMessageId ?? null, conversationId: conversation.id, errorCode: errorCodeOf(err), errorDetails: errorDetailsOf(err), data: { type: m.type } });
    });
  emitToWorkspace(workspaceId, 'message:new', { conversation, message: await withSender(message) });
  // Phones with the app in the background or closed: the same people the live alert goes to (in the background)
  void pushCustomerMessage(workspaceId, conversation, message);
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
  await runAutomations(workspaceId, conversation.id).catch((err) => {
    console.error('[automations] failed', conversation.id, (err as Error).message);
    void logEvent({ level: 'ERROR', category: 'system', event: 'automation.failed', message: `Automations failed for an incoming message: ${(err as Error)?.message ?? err}`, workspaceId, messageId: message.id, conversationId: conversation.id, errorCode: errorCodeOf(err), errorDetails: errorDetailsOf(err) });
  });
  return message;
}

// Meta's timestamps (seconds since 1970, sent as text) as numbers in the logs
const metaTime = (t: unknown) => (t === null || t === undefined || t === '' ? null : Number.isFinite(Number(t)) ? Number(t) : String(t));
// …and as an exact time (ISO 8601, UTC), when it is one
const metaIso = (t: unknown) => {
  const n = Number(t);
  return t !== null && t !== undefined && t !== '' && Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
};

const STATUS_RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

// Meta's error on a status update: its numeric code, title and details (only for failed statuses)
export function statusError(s: any): { code: number | null; title: string | null; details: string | null } | null {
  const first = statusErrors(s)[0];
  return first ? { code: first.code, title: first.title, details: first.details } : null;
}

// Every error Meta listed on a status update (usually one), each with what Meta documents its code to mean (null
// when the code isn't documented: then only Meta's own words are logged)
export function statusErrors(s: any): { code: number | null; title: string | null; details: string | null; meaning: string | null }[] {
  return (Array.isArray(s?.errors) ? s.errors : []).map((e: any) => {
    const code = Number.isFinite(Number(e?.code)) && e?.code !== '' && e?.code !== null ? Number(e.code) : null;
    const details = e?.error_data?.details ?? e?.message ?? null;
    return { code, title: typeof e?.title === 'string' ? e.title : null, details: typeof details === 'string' ? details : null, meaning: explainMetaError(code) };
  });
}

// Why a status says the message wasn't delivered, from Meta's errors only: Meta's code, title and details, plus the
// documented meaning of the code. When Meta gave no error, that is said as it is (never a guessed reason).
export function failureReason(s: any) {
  const errors = statusErrors(s);
  if (!errors.length) return "Meta reported the message as failed but gave no error code or reason";
  return errors
    .map((e) => {
      const said = [e.title, e.details && e.details !== e.title ? e.details : null].filter(Boolean).join(': ') || 'no title or details';
      const code = e.code !== null ? `code ${e.code}` : 'no error code';
      return `Meta: "${said}" (${code})${e.meaning ? `. Meta documents code ${e.code} as: ${e.meaning}` : e.code !== null ? `. Code ${e.code} has no documented meaning in this app's list` : ''}`;
    })
    .join('; ');
}

// What a status webhook adds besides the status (no customer data): Meta's time for it, and the conversation and
// pricing details Meta attaches (its category, whether it's billable)
function statusFacts(s: any) {
  return {
    metaTimestamp: metaTime(s?.timestamp),
    metaTime: metaIso(s?.timestamp),
    // The customer it was for (with LOG_CUSTOMER_DATA)
    recipientId: typeof s?.recipient_id === 'string' ? s.recipient_id : null,
    conversationCategory: s?.conversation?.origin?.type ?? s?.pricing?.category ?? null,
    conversationExpiresAt: metaIso(s?.conversation?.expiration_timestamp),
    billable: typeof s?.pricing?.billable === 'boolean' ? s.pricing.billable : null,
    pricingModel: s?.pricing?.pricing_model ?? null,
  };
}

// What the status confirms about the customer: delivered or read 1, failed 0, anything else (sent) not confirmed
export const customerReceivedFor = (status: unknown): 0 | 1 | null => (status === 'delivered' || status === 'read' ? 1 : status === 'failed' ? 0 : null);

export async function applyStatus(workspaceId: string, s: any) {
  const message = await prisma.message.findUnique({ where: { waMessageId: s.id } });
  if (!message) {
    // Not one of ours (e.g. sent from the WhatsApp app on the phone), sent by a call that timed out here, or deleted
    // since: recorded, not dropped
    const error = statusError(s);
    void logEvent({
      level: s?.status === 'failed' ? 'ERROR' : 'WARNING',
      category: 'message',
      event: 'message.status_unmatched',
      message: `Status "${s?.status}" for a message not in this app${s?.status === 'failed' ? `: ${failureReason(s)}` : ''}`,
      direction: 'out',
      outcome: 'ignored',
      newStatus: s?.status ?? null,
      deliveryStatus: s?.status ?? null,
      customerReceived: customerReceivedFor(s?.status),
      reason: `Meta reported "${s?.status}" for a WhatsApp message this app has no record of (sent from the phone, sent by a request that timed out here, or deleted)`,
      workspaceId,
      waMessageId: s?.id ?? null,
      errorCode: error?.code ?? null,
      errorDetails: s?.status === 'failed' ? failureReason(s) : (error?.title ?? null),
      data: statusFacts(s),
    });
    return;
  }
  // Statuses can arrive out of order; never downgrade read -> delivered (the late one is recorded)
  if ((STATUS_RANK[s.status] ?? 0) <= (STATUS_RANK[message.status] ?? 0)) {
    void logEvent({ level: 'SUCCESS', category: 'message', event: 'message.status_stale', message: `Status "${s.status}" arrived after "${message.status}", kept "${message.status}"`, direction: 'out', outcome: 'skipped', previousStatus: message.status, newStatus: message.status, deliveryStatus: message.status, messageSent: 1, customerReceived: customerReceivedFor(message.status), reason: `Meta reported "${s.status}" after the message was already "${message.status}" (statuses arrive out of order; a status never goes back)`, workspaceId, messageId: message.id, waMessageId: message.waMessageId, conversationId: message.conversationId, data: { received: s?.status ?? null, ...statusFacts(s) }, fileOnly: true });
    return;
  }
  const updated = await prisma.message.update({
    where: { id: message.id },
    data: { status: s.status, error: s.errors?.[0]?.title },
  });
  emitToWorkspace(workspaceId, 'message:status', await withSender(updated));
  logStatus(workspaceId, message, s);
}

// One entry per status change of an outgoing message (sent → delivered → read, or failed with Meta's reason), with
// Meta's exact time for it and how long after the message was created it came
export function logStatus(workspaceId: string, message: { id: string; conversationId: string; status: string; type: string; waMessageId: string | null; createdAt?: Date | null }, s: any) {
  const facts = statusFacts(s);
  const createdAt = message.createdAt instanceof Date ? message.createdAt.getTime() : null;
  const afterSendMs = createdAt !== null && typeof facts.metaTimestamp === 'number' ? Math.max(0, facts.metaTimestamp * 1000 - createdAt) : null;
  const data = { type: message.type, fromStatus: message.status, toStatus: s.status, ...facts, msSinceCreated: afterSendMs };
  const ids = {
    direction: 'out' as const,
    previousStatus: message.status,
    newStatus: s.status,
    deliveryStatus: s.status ?? null,
    messageSent: 1 as const, // Meta only reports statuses for messages it accepted
    customerReceived: customerReceivedFor(s.status),
    reason: `Meta's webhook reported the message as "${s.status}" (it was "${message.status}")`,
    messageId: message.id,
    waMessageId: message.waMessageId,
    conversationId: message.conversationId,
  };
  const timing = facts.metaTime ? ` at ${facts.metaTime}${afterSendMs !== null ? ` (${(afterSendMs / 1000).toFixed(1)} s after it was sent)` : ''}` : '';
  if (s.status !== 'failed') {
    const confirms = s.status === 'delivered' || s.status === 'read' ? '; the customer received it' : s.status === 'sent' ? '; not yet confirmed delivered' : '';
    void logEvent({ ...ids, level: 'SUCCESS', category: 'message', event: 'message.status', message: `Message ${message.status} → ${s.status}${timing}${confirms}`, outcome: 'updated', workspaceId, data });
    return;
  }
  const error = statusError(s);
  const why = failureReason(s);
  void logEvent({
    level: 'ERROR',
    category: 'message',
    event: 'message.status',
    message: `WhatsApp didn't deliver a message${timing}: ${why}`,
    ...ids,
    outcome: 'not delivered',
    workspaceId,
    errorCode: error?.code ?? null,
    errorDetails: why,
    data: { ...data, errors: statusErrors(s) },
  });
}
