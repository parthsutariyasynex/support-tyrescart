import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToUser, emitToWorkspace } from '../realtime.js';
import { notFound } from './errors.js';
import { logEvent } from './logging.js';

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

// "Delete chat", like WhatsApp: only for the person who deletes it. The chat leaves their list (also after a
// refresh) and its history so far is cleared for them; a newer message (the customer's or anyone's reply) brings it
// back, empty up to the delete. Nothing is removed: the conversation, messages, files and logs stay, and teammates
// keep seeing everything. No table of its own: the clear row (above) hides the history, and a personal
// "chat_deleted" activity row (never shown to anyone) marks when it left the list.
export async function deleteConversationForUser({ userId, workspaceId }: AuthPayload, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, workspaceId, contact: { deletedAt: null } }, select: { id: true } });
  if (!conversation) throw notFound('Conversation');
  const now = new Date();
  await prisma.$transaction([
    prisma.conversationClear.upsert({
      where: { userId_conversationId: { userId, conversationId } },
      update: { clearedAt: now },
      create: { userId, conversationId, clearedAt: now },
    }),
    prisma.activityEvent.create({ data: { workspaceId, conversationId, actorId: userId, type: 'chat_deleted', createdAt: now } }),
    // A deleted chat isn't kept pinned (as in WhatsApp)
    prisma.conversationPin.deleteMany({ where: { userId, conversationId } }),
  ]);
  // Only this person's other tabs drop it from their list
  emitToUser(workspaceId, userId, 'conversation:deleted', { conversationId, deletedAt: now });
  void logEvent({
    level: 'SUCCESS',
    category: 'system',
    event: 'conversation.deleted_for_user',
    message: "Chat deleted from one person's list (kept in the database)",
    reason: 'A teammate chose Delete chat and confirmed',
    outcome: 'hidden',
    previousStatus: 'visible',
    newStatus: 'hidden',
    workspaceId,
    userId,
    conversationId,
  });
  return true;
}

// Chats this person deleted (above) that had no message since: left out of their chat list
export async function deletedConversationIds(userId: string, workspaceId: string) {
  const rows = await prisma.activityEvent.findMany({
    where: { workspaceId, actorId: userId, type: 'chat_deleted', conversationId: { not: null } },
    select: { conversationId: true, createdAt: true, conversation: { select: { lastMessageAt: true } } },
  });
  const latest = new Map<string, { at: Date; lastMessageAt: Date }>();
  for (const r of rows) {
    if (!r.conversationId || !r.conversation) continue;
    const seen = latest.get(r.conversationId);
    if (!seen || r.createdAt > seen.at) latest.set(r.conversationId, { at: r.createdAt, lastMessageAt: r.conversation.lastMessageAt });
  }
  return [...latest].filter(([, d]) => d.lastMessageAt <= d.at).map(([id]) => id);
}
