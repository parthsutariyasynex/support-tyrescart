import { prisma } from '../prisma.js';

// Who sent a message, always worked out on the server from the database (never from client input):
// customer messages -> the conversation's contact name (or their number); agent messages -> the name of
// the user in `sentById`. Older agent messages sent before sender tracking have no sentById, so no name.
type MessageLike = { direction: string; sentById?: string | null; conversationId: string; replyToId?: string | null };

export async function senderName(m: MessageLike): Promise<string | null> {
  if (m.direction === 'in') {
    const conversation = await prisma.conversation.findUnique({
      where: { id: m.conversationId },
      select: { contact: { select: { name: true, waId: true } } },
    });
    return conversation ? conversation.contact.name || `+${conversation.contact.waId}` : null;
  }
  if (!m.sentById) return null;
  const user = await prisma.user.findUnique({ where: { id: m.sentById }, select: { name: true } });
  return user?.name ?? null;
}

// The message a reply quotes, as the chat shows it above the reply: who wrote it and its text (empty once deleted)
export type Quote = { id: string; direction: string; type: string; body: string; senderName: string | null; deleted: boolean; mediaMime: string | null; mediaName: string | null };
export async function quoteOf(replyToId: string | null | undefined): Promise<Quote | null> {
  if (!replyToId) return null;
  const q = await prisma.message.findUnique({
    where: { id: replyToId },
    select: { id: true, direction: true, type: true, body: true, sentById: true, conversationId: true, deletedAt: true, mediaMime: true, mediaName: true, automation: true },
  });
  if (!q) return null;
  return {
    id: q.id,
    direction: q.direction,
    type: q.type,
    body: q.deletedAt ? '' : q.body,
    senderName: (await senderName(q)) ?? (q.automation ? 'Auto-reply' : null),
    deleted: !!q.deletedAt,
    mediaMime: q.mediaMime,
    mediaName: q.mediaName,
  };
}

// For Socket.IO payloads, so live messages show the same name (and quoted message) as loaded ones
export async function withSender<T extends MessageLike>(m: T): Promise<T & { senderName: string | null; replyTo?: Quote | null }> {
  return { ...m, senderName: await senderName(m), ...(m.replyToId ? { replyTo: await quoteOf(m.replyToId) } : {}) };
}
