import type { Prisma } from '@prisma/client';
import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { notFound } from './errors.js';

// Activity history: what happened in each chat and who did it. Shown as a timeline in the chat and in
// the header's notification bell. Recording never fails the action it describes.

export type ActivityType =
  | 'conversation_closed'
  | 'conversation_reopened'
  | 'assigned'
  | 'unassigned'
  | 'label_added'
  | 'label_removed'
  | 'message_edited'
  | 'message_deleted'
  | 'message_restored'
  | 'message_received';

// Customer messages already appear as bubbles, so they're only in the bell, not the chat timeline
const NOT_IN_TIMELINE: ActivityType[] = ['message_received'];

type Row = Prisma.ActivityEventGetPayload<{ include: { conversation: { select: { contact: true } } } }>;

async function toActivity(row: Row) {
  const actor = row.actorId ? await prisma.user.findUnique({ where: { id: row.actorId }, select: { name: true } }) : null;
  const contact = row.conversation?.contact;
  return {
    id: row.id,
    type: row.type,
    conversationId: row.conversationId,
    actorId: row.actorId,
    actorName: actor?.name ?? null,
    contactName: contact ? contact.name || `+${contact.waId}` : null,
    data: row.data ? JSON.stringify(row.data) : null,
    createdAt: row.createdAt,
  };
}

const include = { conversation: { select: { contact: true } } } as const;

export async function recordActivity(e: {
  workspaceId: string;
  conversationId: string;
  actorId: string | null;
  type: ActivityType;
  data?: Prisma.InputJsonValue;
}) {
  try {
    const row = await prisma.activityEvent.create({ data: e, include });
    emitToWorkspace(e.workspaceId, 'activity:new', await toActivity(row));
  } catch (err) {
    console.error('[activity] could not record', e.type, err);
  }
}

// Chat timeline, oldest -> newest (most recent `first` events)
export async function listConversationActivity(
  workspaceId: string,
  conversationId: string,
  first = 200,
  hideBefore?: Date | null, // the viewer cleared the chat at this time
) {
  if (!(await prisma.conversation.findFirst({ where: { id: conversationId, workspaceId }, select: { id: true } })))
    throw notFound('Conversation');
  const rows = await prisma.activityEvent.findMany({
    where: {
      workspaceId,
      conversationId,
      type: { notIn: NOT_IN_TIMELINE },
      ...(hideBefore ? { createdAt: { gt: hideBefore } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(Math.max(first, 1), 500),
    include,
  });
  return Promise.all(rows.reverse().map(toActivity));
}

// Bell: newest events in the workspace done by someone else (or by customers), plus how many are unseen
export async function listNotifications({ userId, workspaceId }: AuthPayload, first = 30) {
  const notMine = { OR: [{ actorId: null }, { actorId: { not: userId } }] };
  const member = await prisma.member.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { notificationsSeenAt: true },
  });
  const [rows, unseen] = await Promise.all([
    prisma.activityEvent.findMany({
      where: { workspaceId, ...notMine },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(first, 1), 100),
      include,
    }),
    prisma.activityEvent.count({
      where: { workspaceId, ...notMine, ...(member?.notificationsSeenAt ? { createdAt: { gt: member.notificationsSeenAt } } : {}) },
    }),
  ]);
  return { items: await Promise.all(rows.map(toActivity)), unseen, seenAt: member?.notificationsSeenAt ?? null };
}

export async function markNotificationsSeen({ userId, workspaceId }: AuthPayload) {
  await prisma.member.update({
    where: { userId_workspaceId: { userId, workspaceId } },
    data: { notificationsSeenAt: new Date() },
  });
  return true;
}

// Total unread customer messages in the workspace (browser tab title)
export async function unreadTotal(workspaceId: string) {
  const { _sum } = await prisma.conversation.aggregate({ where: { workspaceId }, _sum: { unread: true } });
  return _sum.unread ?? 0;
}
