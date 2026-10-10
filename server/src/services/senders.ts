import { prisma } from '../prisma.js';

// Who sent a message, always worked out on the server from the database (never from client input):
// customer messages -> the conversation's contact name (or their number); agent messages -> the name of
// the user in `sentById`. Older agent messages sent before sender tracking have no sentById, so no name.
type MessageLike = { direction: string; sentById?: string | null; conversationId: string };

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

// For Socket.IO payloads, so live messages show the same name as loaded ones
export async function withSender<T extends MessageLike>(m: T): Promise<T & { senderName: string | null }> {
  return { ...m, senderName: await senderName(m) };
}
