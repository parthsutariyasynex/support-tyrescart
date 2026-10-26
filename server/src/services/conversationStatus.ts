import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { recordActivity } from './activity.js';
import { AppError } from './errors.js';
import { NEW_LEAD_WHERE, requireConversation } from './inbox.js';
import { logEvent, logFailure } from './logging.js';

// Close / snooze / reopen a chat (WhatsApp Business-style). Only the status changes: messages, labels, assignee
// and customer details stay. Any member of the workspace can do it. A snoozed chat comes back to open at
// snoozedUntil (wakeSnoozedConversations) or as soon as the customer writes again (wakeOnCustomerMessage).
export type ConversationStatus = 'open' | 'snoozed' | 'closed';

export const SNOOZE_MAX_MS = 365 * 24 * 3600 * 1000;

const statusEvent = (c: { id: string; status: string; closedAt: Date | null; closedById: string | null; snoozedUntil: Date | null }) => ({
  conversationId: c.id,
  status: c.status,
  closedAt: c.closedAt,
  closedById: c.closedById,
  snoozedUntil: c.snoozedUntil,
});

async function setStatus(auth: AuthPayload, conversationId: string, status: ConversationStatus, snoozedUntil: Date | null = null) {
  const current = await requireConversation(auth.workspaceId, conversationId);
  const changed = current.status !== status || (status === 'snoozed' && current.snoozedUntil?.getTime() !== snoozedUntil?.getTime());
  if (changed) {
    // Conditional update so two agents clicking at once don't both "win" with different timestamps
    await prisma.conversation.updateMany({
      where: { id: conversationId, workspaceId: auth.workspaceId, status: current.status },
      data:
        status === 'closed'
          ? { status, closedAt: new Date(), closedById: auth.userId, snoozedUntil: null, updatedBy: auth.userId }
          : status === 'snoozed'
            ? { status, snoozedUntil, closedAt: null, closedById: null, updatedBy: auth.userId }
            : { status, closedAt: null, closedById: null, snoozedUntil: null, updatedBy: auth.userId },
    });
  }
  const conversation = await requireConversation(auth.workspaceId, conversationId);
  const verb = status === 'closed' ? 'closed' : status === 'snoozed' ? `snoozed until ${snoozedUntil!.toISOString()}` : 'reopened';
  void logEvent({
    level: 'SUCCESS',
    category: 'system',
    event: 'conversation.status_changed',
    message: changed ? `Chat ${verb} (was ${current.status})` : `Chat already ${current.status}: nothing changed`,
    reason: `A teammate ${verb} the chat`,
    outcome: changed ? 'changed' : 'unchanged',
    previousStatus: current.status,
    newStatus: conversation.status,
    workspaceId: auth.workspaceId,
    userId: auth.userId,
    conversationId,
    data: status === 'snoozed' ? { snoozedUntil: snoozedUntil!.toISOString() } : undefined,
  });
  if (changed) {
    emitToWorkspace(auth.workspaceId, 'conversation:status', statusEvent(conversation));
    await recordActivity({
      workspaceId: auth.workspaceId,
      conversationId,
      actorId: auth.userId,
      type: status === 'closed' ? 'conversation_closed' : status === 'snoozed' ? 'conversation_snoozed' : 'conversation_reopened',
      ...(status === 'snoozed' ? { data: { until: snoozedUntil!.toISOString() } } : {}),
    });
  }
  return conversation;
}

export const closeConversation = (auth: AuthPayload, id: string) => setStatus(auth, id, 'closed');
export const reopenConversation = (auth: AuthPayload, id: string) => setStatus(auth, id, 'open');

// Snooze until a time in the future (at most a year ahead)
export function snoozeConversation(auth: AuthPayload, id: string, until: Date) {
  if (!(until instanceof Date) || Number.isNaN(until.getTime())) throw new AppError('Invalid snooze time', 400, 'BAD_USER_INPUT');
  const ms = until.getTime() - Date.now();
  if (ms <= 0) throw new AppError('Snooze until a time in the future', 400, 'BAD_USER_INPUT');
  if (ms > SNOOZE_MAX_MS) throw new AppError('Snooze for at most a year', 400, 'BAD_USER_INPUT');
  return setStatus(auth, id, 'snoozed', until);
}

// Back to open, by the system (time's up or the customer wrote). Conditional, so it only wakes chats still snoozed.
async function wake(conversationId: string, workspaceId: string, reason: 'snooze_ended' | 'customer_replied') {
  const { count } = await prisma.conversation.updateMany({
    where: { id: conversationId, workspaceId, status: 'snoozed' },
    data: { status: 'open', snoozedUntil: null },
  });
  if (!count) return false;
  void logEvent({
    level: 'SUCCESS',
    category: 'system',
    event: 'conversation.woken',
    message: 'Snoozed chat reopened',
    reason: reason === 'snooze_ended' ? 'The time the chat was snoozed until has come' : 'The customer wrote while the chat was snoozed',
    outcome: 'changed',
    previousStatus: 'snoozed',
    newStatus: 'open',
    workspaceId,
    conversationId,
  });
  const conversation = await requireConversation(workspaceId, conversationId);
  emitToWorkspace(workspaceId, 'conversation:status', statusEvent(conversation));
  await recordActivity({ workspaceId, conversationId, actorId: null, type: 'conversation_reopened', data: { reason } });
  return true;
}

// Every snoozed chat whose time has come is reopened. Returns how many.
export async function wakeSnoozedConversations(now = new Date()) {
  const due = await prisma.conversation.findMany({ where: { status: 'snoozed', snoozedUntil: { lte: now } }, select: { id: true, workspaceId: true } });
  let woke = 0;
  for (const c of due) if (await wake(c.id, c.workspaceId, 'snooze_ended')) woke++;
  return woke;
}

export const wakeOnCustomerMessage = (conversationId: string, workspaceId: string) => wake(conversationId, workspaceId, 'customer_replied');

// Checks every 30 seconds; returns a stop function
export function startSnoozeWaker(intervalMs = 30_000) {
  const timer = setInterval(
    () =>
      wakeSnoozedConversations().catch((err) => {
        console.error('[snooze] wake failed', err);
        void logFailure('job.snooze_failed', 'Waking snoozed chats failed', err);
      }),
    intervalMs,
  );
  timer.unref();
  return () => clearInterval(timer);
}

// For the Open / Closed tabs, and the "closed chats have new messages" notice
export async function conversationCounts(workspaceId: string) {
  // Same chats as the lists: deleted contacts' chats are left out
  const base = { workspaceId, contact: { deletedAt: null } };
  const [open, closed, closedWithUnread, unassigned, snoozed, newLeads] = await Promise.all([
    prisma.conversation.count({ where: { ...base, status: 'open' } }),
    prisma.conversation.count({ where: { ...base, status: 'closed' } }),
    prisma.conversation.count({ where: { ...base, status: 'closed', unread: { gt: 0 } } }),
    prisma.conversation.count({ where: { ...base, assignedToId: null } }),
    prisma.conversation.count({ where: { ...base, status: 'snoozed' } }),
    prisma.conversation.count({ where: { ...base, ...NEW_LEAD_WHERE } }),
  ]);
  return { open, closed, closedWithUnread, unassigned, snoozed, newLeads };
}
