import type { Prisma } from '@prisma/client';
import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToUser, emitToWorkspace } from '../realtime.js';
import { notFound } from './errors.js';
import { isAdminRole } from './roles.js';

// Activity history: what happened in each chat and who did it. Shown as a timeline in the chat and in
// the header's notification bell. Recording never fails the action it describes.

export type ActivityType =
  | 'conversation_closed'
  | 'conversation_reopened'
  | 'assigned'
  | 'reassigned'
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
    const activity = await toActivity(row);
    // Chat timelines (anyone who has the chat open) keep getting every event
    emitToWorkspace(e.workspaceId, 'activity:new', activity);
    // The bell is per person: owners/admins get everything; everyone else only what concerns them (their chats,
    // or an assignment naming them). The person who did it isn't notified of their own action.
    for (const userId of await notificationRecipients(e.workspaceId, e.conversationId, e.data))
      if (userId !== e.actorId) emitToUser(e.workspaceId, userId, 'notification:new', activity);
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

// Who a new event's bell notification goes to: every active owner/admin, the chat's current assignee, and the
// person an assignment names (data.assigneeUserId)
async function notificationRecipients(workspaceId: string, conversationId: string, data: Prisma.InputJsonValue | undefined) {
  const [admins, conversation] = await Promise.all([
    prisma.member.findMany({ where: { workspaceId, active: true, role: { in: ['owner', 'admin'] } }, select: { userId: true } }),
    prisma.conversation.findUnique({ where: { id: conversationId }, select: { assignedTo: { select: { userId: true } } } }),
  ]);
  const recipients = new Set(admins.map((a) => a.userId));
  if (conversation?.assignedTo) recipients.add(conversation.assignedTo.userId);
  const named = data && typeof data === 'object' && !Array.isArray(data) ? (data as { assigneeUserId?: unknown }).assigneeUserId : undefined;
  if (typeof named === 'string') recipients.add(named);
  return [...recipients];
}

// What a person may see in their bell. Owners and admins: everything in the workspace. Everyone else: only events
// on chats currently assigned to them, or assignments that name them. Enforced here, not in the UI.
function visibleTo(userId: string, role: string): Prisma.ActivityEventWhereInput {
  if (isAdminRole(role)) return {};
  return { OR: [{ conversation: { assignedTo: { userId } } }, { data: { path: '$.assigneeUserId', equals: userId } }] };
}

// Bell: newest events done by someone else (or by customers) that this person may see, plus how many are unseen
export async function listNotifications({ userId, workspaceId }: AuthPayload, first = 30) {
  const notMine = { OR: [{ actorId: null }, { actorId: { not: userId } }] };
  const member = await prisma.member.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { notificationsSeenAt: true, role: true },
  });
  if (!member) return { items: [], unseen: 0, seenAt: null };
  const where: Prisma.ActivityEventWhereInput = { workspaceId, AND: [notMine, visibleTo(userId, member.role)] };
  const [rows, unseen] = await Promise.all([
    prisma.activityEvent.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(first, 1), 100),
      include,
    }),
    prisma.activityEvent.count({
      where: { ...where, ...(member.notificationsSeenAt ? { createdAt: { gt: member.notificationsSeenAt } } : {}) },
    }),
  ]);
  return { items: await Promise.all(rows.map(toActivity)), unseen, seenAt: member.notificationsSeenAt };
}

export async function markNotificationsSeen({ userId, workspaceId }: AuthPayload) {
  await prisma.member.update({
    where: { userId_workspaceId: { userId, workspaceId } },
    data: { notificationsSeenAt: new Date(), updatedBy: userId },
  });
  return true;
}

// Total unread customer messages in the workspace (browser tab title)
export async function unreadTotal(workspaceId: string) {
  const { _sum } = await prisma.conversation.aggregate({ where: { workspaceId }, _sum: { unread: true } });
  return _sum.unread ?? 0;
}
