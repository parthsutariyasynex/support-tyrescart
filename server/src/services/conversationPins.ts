import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { AppError, notFound } from './errors.js';
import { requireConversation } from './inbox.js';
import { logEvent } from './logging.js';
import { getPermissions, requireAdmin } from './permissions.js';
import { settingsOf } from './workspaceSettings.js';

// Pinned chats and messages, for the whole team (like WhatsApp's pins, shared by everyone in the workspace), and
// "Mark as unread" from the chat's ⋮ menu. Chats: every member who can open the chat pins and unpins them (within the
// limit); messages: owners and admins. Everyone sees the pins at once
// (conversation:pinned / message:pinned). The limit is the admin's setting (Workspace preferences, pinLimit, default 5):
// at most that many pinned chats in the workspace, and that many pinned messages in each chat. Stored on the chat or message
// itself (pinnedAt, pinnedBy); pinning and unpinning also fill in its standard audit fields (updatedAt, updatedBy).
// Replaced: export const MAX_PINS = 3; (per person)

// Replaced by the team-wide pins below (pins were per person, at most MAX_PINS = 3):
// // The viewer's pinned chats in this workspace, most recently pinned first
// export async function pinnedIds(userId: string, workspaceId: string) {
//   const pins = await prisma.conversationPin.findMany({
//     where: { userId, conversation: { workspaceId } },
//     orderBy: { createdAt: 'desc' },
//     select: { conversationId: true },
//   });
//   return pins.map((p) => p.conversationId);
// }
//
// export async function pinConversation(auth: AuthPayload, conversationId: string) {
//   await requireConversation(auth.workspaceId, conversationId);
//   const pinned = await pinnedIds(auth.userId, auth.workspaceId);
//   if (!pinned.includes(conversationId)) {
//     if (pinned.length >= MAX_PINS)
//       throw new AppError(`You can pin up to ${MAX_PINS} chats. Unpin one first.`, 400, 'PIN_LIMIT');
//     await prisma.conversationPin.create({ data: { userId: auth.userId, conversationId } }).catch(() => {}); // a double click: already pinned
//     emitToUser(auth.workspaceId, auth.userId, 'conversation:pinned', { conversationId, pinned: true });
//   }
//   return requireConversation(auth.workspaceId, conversationId);
// }
//
// export async function unpinConversation(auth: AuthPayload, conversationId: string) {
//   await requireConversation(auth.workspaceId, conversationId);
//   const { count } = await prisma.conversationPin.deleteMany({ where: { userId: auth.userId, conversationId } });
//   if (count) emitToUser(auth.workspaceId, auth.userId, 'conversation:pinned', { conversationId, pinned: false });
//   return requireConversation(auth.workspaceId, conversationId);
// }

// The workspace's pinned chats, most recently pinned first (the ones of deleted contacts left out)
export async function pinnedConversationIds(workspaceId: string) {
  const rows = await prisma.conversation.findMany({
    where: { workspaceId, pinnedAt: { not: null }, contact: { deletedAt: null } },
    orderBy: { pinnedAt: 'desc' },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

const pinLimitText = (limit: number, what: string) => `Up to ${limit} ${what} can be pinned. Unpin one first.`;

// Pins a chat for everyone. Within the limit, checked while the workspace row is locked, so two pins at the same moment
// can't both get past it; pinning an already pinned chat changes nothing.
export async function pinConversation(auth: AuthPayload, conversationId: string) {
  // Replaced (anyone who can open the chat pins it): await requireAdmin(auth);
  await getPermissions(auth); // a member of this workspace (every role)
  await requireConversation(auth.workspaceId, conversationId);
  const limit = (await settingsOf(auth.workspaceId)).pinLimit;
  const pinnedNow = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM Workspace WHERE id = ${auth.workspaceId} FOR UPDATE`;
    const current = await tx.conversation.findUnique({ where: { id: conversationId }, select: { pinnedAt: true } });
    if (current?.pinnedAt) return false;
    const count = await tx.conversation.count({ where: { workspaceId: auth.workspaceId, pinnedAt: { not: null }, contact: { deletedAt: null } } });
    if (count >= limit) throw new AppError(pinLimitText(limit, 'chats'), 400, 'PIN_LIMIT');
    await tx.conversation.update({ where: { id: conversationId }, data: { pinnedAt: new Date(), pinnedBy: auth.userId, updatedBy: auth.userId } });
    return true;
  });
  if (pinnedNow) {
    emitToWorkspace(auth.workspaceId, 'conversation:pinned', { conversationId, pinned: true });
    void logEvent({ level: 'SUCCESS', category: 'system', event: 'pin.conversation', message: 'Chat pinned for the team', outcome: 'pinned', workspaceId: auth.workspaceId, userId: auth.userId, conversationId });
  }
  return requireConversation(auth.workspaceId, conversationId);
}

export async function unpinConversation(auth: AuthPayload, conversationId: string) {
  // Replaced (anyone who can open the chat unpins it): await requireAdmin(auth);
  await getPermissions(auth); // a member of this workspace (every role)
  await requireConversation(auth.workspaceId, conversationId);
  const { count } = await prisma.conversation.updateMany({ where: { id: conversationId, workspaceId: auth.workspaceId, pinnedAt: { not: null } }, data: { pinnedAt: null, pinnedBy: null, updatedBy: auth.userId } });
  if (count) {
    emitToWorkspace(auth.workspaceId, 'conversation:pinned', { conversationId, pinned: false });
    void logEvent({ level: 'SUCCESS', category: 'system', event: 'pin.conversation', message: 'Chat unpinned for the team', outcome: 'unpinned', workspaceId: auth.workspaceId, userId: auth.userId, conversationId });
  }
  return requireConversation(auth.workspaceId, conversationId);
}

// A message of a chat of this workspace (deleted ones can't be pinned)
async function requireMessage(workspaceId: string, messageId: string) {
  const message = await prisma.message.findFirst({ where: { id: messageId, conversation: { workspaceId, contact: { deletedAt: null } } } });
  if (!message) throw notFound('Message');
  return message;
}

// The chat's pinned messages (not deleted ones), most recently pinned first: the bar at the top of the chat
export async function pinnedMessages(workspaceId: string, conversationId: string) {
  await requireConversation(workspaceId, conversationId);
  return prisma.message.findMany({ where: { conversationId, pinnedAt: { not: null }, deletedAt: null }, orderBy: { pinnedAt: 'desc' } });
}

// Pins a message in its chat for everyone. Within the limit per chat, checked while the chat row is locked.
export async function pinMessage(auth: AuthPayload, messageId: string) {
  await requireAdmin(auth);
  const message = await requireMessage(auth.workspaceId, messageId);
  if (message.deletedAt) throw new AppError("A deleted message can't be pinned", 400, 'MESSAGE_DELETED');
  const limit = (await settingsOf(auth.workspaceId)).pinLimit;
  const pinnedNow = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM Conversation WHERE id = ${message.conversationId} FOR UPDATE`;
    const current = await tx.message.findUnique({ where: { id: messageId }, select: { pinnedAt: true } });
    if (current?.pinnedAt) return false;
    const count = await tx.message.count({ where: { conversationId: message.conversationId, pinnedAt: { not: null }, deletedAt: null } });
    if (count >= limit) throw new AppError(pinLimitText(limit, 'messages in a chat'), 400, 'PIN_LIMIT');
    await tx.message.update({ where: { id: messageId }, data: { pinnedAt: new Date(), pinnedBy: auth.userId, updatedBy: auth.userId } });
    return true;
  });
  const updated = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
  if (pinnedNow) {
    emitToWorkspace(auth.workspaceId, 'message:pinned', { conversationId: message.conversationId, messageId, pinned: true, pinnedAt: updated.pinnedAt });
    void logEvent({ level: 'SUCCESS', category: 'system', event: 'pin.message', message: 'Message pinned for the team', outcome: 'pinned', workspaceId: auth.workspaceId, userId: auth.userId, conversationId: message.conversationId, messageId });
  }
  return updated;
}

export async function unpinMessage(auth: AuthPayload, messageId: string) {
  await requireAdmin(auth);
  const message = await requireMessage(auth.workspaceId, messageId);
  const { count } = await prisma.message.updateMany({ where: { id: messageId, pinnedAt: { not: null } }, data: { pinnedAt: null, pinnedBy: null, updatedBy: auth.userId } });
  if (count) {
    emitToWorkspace(auth.workspaceId, 'message:pinned', { conversationId: message.conversationId, messageId, pinned: false, pinnedAt: null });
    void logEvent({ level: 'SUCCESS', category: 'system', event: 'pin.message', message: 'Message unpinned for the team', outcome: 'unpinned', workspaceId: auth.workspaceId, userId: auth.userId, conversationId: message.conversationId, messageId });
  }
  return prisma.message.findUniqueOrThrow({ where: { id: messageId } });
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
