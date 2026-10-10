import { prisma } from './prisma.js';
import { emitToWorkspace } from './realtime.js';
import { recordActivity } from './services/activity.js';
import { withSender } from './services/senders.js';

type Incoming = { waId: string; name?: string; waMessageId?: string; type: string; body: string };

function describe(msg: any): { type: string; body: string } {
  switch (msg.type) {
    case 'text':
      return { type: 'text', body: msg.text.body };
    case 'button':
      return { type: 'button', body: msg.button.text };
    case 'interactive':
      return {
        type: 'interactive',
        body: msg.interactive.button_reply?.title ?? msg.interactive.list_reply?.title ?? '',
      };
    default:
      // image, audio, document, location... download media via Graph API later
      return { type: msg.type, body: `[${msg.type}]` };
  }
}

export function parseWebhookMessage(msg: any, contacts: any[] = []): Incoming {
  const contact = contacts.find((c) => c.wa_id === msg.from);
  return { waId: msg.from, name: contact?.profile?.name, waMessageId: msg.id, ...describe(msg) };
}

export async function saveIncoming(workspaceId: string, m: Incoming) {
  if (m.waMessageId && (await prisma.message.findUnique({ where: { waMessageId: m.waMessageId } })))
    return; // Meta retries webhooks, so ignore duplicates

  const now = new Date();
  const contact = await prisma.contact.upsert({
    where: { workspaceId_waId: { workspaceId, waId: m.waId } },
    update: m.name ? { name: m.name } : {},
    create: { workspaceId, waId: m.waId, name: m.name },
  });
  const conversation = await prisma.conversation.upsert({
    where: { workspaceId_contactId: { workspaceId, contactId: contact.id } },
    update: { lastMessageAt: now, lastInboundAt: now, unread: { increment: 1 } },
    create: { workspaceId, contactId: contact.id, lastMessageAt: now, lastInboundAt: now, unread: 1 },
    include: { contact: true },
  });
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      waMessageId: m.waMessageId,
      direction: 'in',
      type: m.type,
      body: m.body,
      status: 'received',
    },
  });
  emitToWorkspace(workspaceId, 'message:new', { conversation, message: await withSender(message) });
  await recordActivity({
    workspaceId,
    conversationId: conversation.id,
    actorId: null,
    type: 'message_received',
    data: { messageId: message.id, preview: m.body.slice(0, 100) },
  });
  // TODO: run automations / bot replies here
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
