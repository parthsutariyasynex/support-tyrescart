import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { notFound } from './errors.js';

// "Clear chat", like WhatsApp: only for the person who clears it. Their view of the chat starts empty from
// that moment (messages and activity before it are hidden); nothing is deleted and teammates see everything.

export async function clearedAt(userId: string | undefined, conversationId: string) {
  if (!userId) return null;
  const row = await prisma.conversationClear.findUnique({
    where: { userId_conversationId: { userId, conversationId } },
    select: { clearedAt: true },
  });
  return row?.clearedAt ?? null;
}

export async function clearConversation({ userId, workspaceId }: AuthPayload, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, workspaceId }, select: { id: true } });
  if (!conversation) throw notFound('Conversation');
  const now = new Date();
  await prisma.conversationClear.upsert({
    where: { userId_conversationId: { userId, conversationId } },
    update: { clearedAt: now },
    create: { userId, conversationId, clearedAt: now },
  });
  // Only the same user's other tabs act on this (everyone else ignores it)
  emitToWorkspace(workspaceId, 'conversation:cleared', { conversationId, userId, clearedAt: now });
  return now;
}
