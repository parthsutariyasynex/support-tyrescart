import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToUser, emitToWorkspace } from '../realtime.js';
import { AppError } from './errors.js';
import { requireConversation } from './inbox.js';

// "Pin conversation" (per person, like WhatsApp) and "Mark as unread" from the chat's ⋮ menu

export const MAX_PINS = 3;

// The viewer's pinned chats in this workspace, most recently pinned first
export async function pinnedIds(userId: string, workspaceId: string) {
  const pins = await prisma.conversationPin.findMany({
    where: { userId, conversation: { workspaceId } },
    orderBy: { createdAt: 'desc' },
    select: { conversationId: true },
  });
  return pins.map((p) => p.conversationId);
}

export async function pinConversation(auth: AuthPayload, conversationId: string) {
  await requireConversation(auth.workspaceId, conversationId);
  const pinned = await pinnedIds(auth.userId, auth.workspaceId);
  if (!pinned.includes(conversationId)) {
    if (pinned.length >= MAX_PINS)
      throw new AppError(`You can pin up to ${MAX_PINS} chats. Unpin one first.`, 400, 'PIN_LIMIT');
    await prisma.conversationPin.create({ data: { userId: auth.userId, conversationId } }).catch(() => {}); // a double click: already pinned
    emitToUser(auth.workspaceId, auth.userId, 'conversation:pinned', { conversationId, pinned: true });
  }
  return requireConversation(auth.workspaceId, conversationId);
}

export async function unpinConversation(auth: AuthPayload, conversationId: string) {
  await requireConversation(auth.workspaceId, conversationId);
  const { count } = await prisma.conversationPin.deleteMany({ where: { userId: auth.userId, conversationId } });
  if (count) emitToUser(auth.workspaceId, auth.userId, 'conversation:pinned', { conversationId, pinned: false });
  return requireConversation(auth.workspaceId, conversationId);
}

// Back to unread (at least 1), so it shows bold with a badge until someone opens it again. Unread is shared by the
// workspace, like the count customer messages add, so everyone's list updates.
export async function markConversationUnread(auth: AuthPayload, conversationId: string) {
  const current = await requireConversation(auth.workspaceId, conversationId);
  if (current.unread === 0) {
    await prisma.conversation.updateMany({ where: { id: conversationId, workspaceId: auth.workspaceId, unread: 0 }, data: { unread: 1, updatedBy: auth.userId } });
    emitToWorkspace(auth.workspaceId, 'conversation:unread', { conversationId, unread: 1 });
  }
  return requireConversation(auth.workspaceId, conversationId);
}
