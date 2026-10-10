import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { recordActivity } from './activity.js';
import { requireConversation } from './inbox.js';

// Close / reopen a chat (WhatsApp Business-style "Close chat"). Only the status changes: messages,
// labels, assignee and customer details stay. Any member of the workspace can do it.
export type ConversationStatus = 'open' | 'closed';

async function setStatus(auth: AuthPayload, conversationId: string, status: ConversationStatus) {
  const current = await requireConversation(auth.workspaceId, conversationId);
  if (current.status !== status) {
    // Conditional update so two agents clicking at once don't both "win" with different timestamps
    await prisma.conversation.updateMany({
      where: { id: conversationId, workspaceId: auth.workspaceId, status: current.status },
      data:
        status === 'closed'
          ? { status, closedAt: new Date(), closedById: auth.userId }
          : { status, closedAt: null, closedById: null },
    });
  }
  const conversation = await requireConversation(auth.workspaceId, conversationId);
  if (current.status !== status) {
    emitToWorkspace(auth.workspaceId, 'conversation:status', {
      conversationId,
      status: conversation.status,
      closedAt: conversation.closedAt,
      closedById: conversation.closedById,
    });
    await recordActivity({
      workspaceId: auth.workspaceId,
      conversationId,
      actorId: auth.userId,
      type: status === 'closed' ? 'conversation_closed' : 'conversation_reopened',
    });
  }
  return conversation;
}

export const closeConversation = (auth: AuthPayload, id: string) => setStatus(auth, id, 'closed');
export const reopenConversation = (auth: AuthPayload, id: string) => setStatus(auth, id, 'open');

// For the Open / Closed tabs, and the "closed chats have new messages" notice
export async function conversationCounts(workspaceId: string) {
  const [open, closed, closedWithUnread] = await Promise.all([
    prisma.conversation.count({ where: { workspaceId, status: 'open' } }),
    prisma.conversation.count({ where: { workspaceId, status: 'closed' } }),
    prisma.conversation.count({ where: { workspaceId, status: 'closed', unread: { gt: 0 } } }),
  ]);
  return { open, closed, closedWithUnread };
}
