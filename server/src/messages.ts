import { prisma } from './prisma.js';
import { wakeOnCustomerMessage } from './services/conversationStatus.js';
import { emitToWorkspace } from './realtime.js';
import { recordActivity } from './services/activity.js';
import { withSender } from './services/senders.js';
import { cleanIncomingName, cleanMime, fetchIncomingMedia } from './services/incomingMedia.js';
import { defaultStageValue } from './services/leadStages.js';
import { runAutomations } from './services/automations.js';

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
};

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
    default:
      // location, contacts, reaction...: a placeholder
      return { type: msg.type, body: `[${msg.type}]` };
  }
}

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
  const existed = await prisma.conversation.findUnique({ where: { workspaceId_contactId: { workspaceId, contactId: contact.id } }, select: { id: true } });
  const conversation = await prisma.conversation.upsert({
    where: { workspaceId_contactId: { workspaceId, contactId: contact.id } },
    update: { lastMessageAt: now, lastInboundAt: now, unread: { increment: 1 } },
    create: { workspaceId, contactId: contact.id, lastMessageAt: now, lastInboundAt: now, unread: 1 },
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
    data: { messageId: message.id, preview: m.body.slice(0, 100) },
  });
  // Simple automations (routing, auto-reply); they never stop the message from being saved
  await runAutomations(workspaceId, conversation.id).catch((err) => console.error('[automations] failed', conversation.id, (err as Error).message));
  return message;
}

const STATUS_RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

export async function applyStatus(workspaceId: string, s: any) {
  const message = await prisma.message.findUnique({ where: { waMessageId: s.id } });
  // Statuses can arrive out of order; never downgrade read -> delivered
  if (!message || (STATUS_RANK[s.status] ?? 0) <= (STATUS_RANK[message.status] ?? 0)) return;
  const updated = await prisma.message.update({
    where: { id: message.id },
    data: { status: s.status, error: s.errors?.[0]?.title },
  });
  emitToWorkspace(workspaceId, 'message:status', await withSender(updated));
}
