import type { Prisma } from '@prisma/client';
import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToUser, emitToWorkspace } from '../realtime.js';
import { notFound } from './errors.js';
import { isAdminRole } from './roles.js';
import { logFailure } from './logging.js';

// Activity history: what happened in each chat and who did it. Shown as a timeline in the chat and in
// the header's notification bell. Recording never fails the action it describes.

export type ActivityType =
  | 'conversation_closed'
  | 'conversation_reopened'
  | 'conversation_snoozed'
  | 'collaborators_added'
  | 'collaborator_removed'
  | 'assigned'
  | 'reassigned'
  | 'unassigned'
  | 'label_added'
  | 'label_removed'
  | 'message_edited'
  | 'message_deleted'
  | 'message_restored'
  | 'message_received'
  // Customer profile (contact details page only)
  | 'contact_updated'
  | 'remark_added'
  | 'remark_edited'
  | 'remark_deleted'
  | 'message_sent'
  | 'list_added'
  | 'list_removed'
  // An internal note @mentioned someone (one per person and note; data: remarkId, mentionedUserId, text): only that
  // person's bell and Mentions list
  | 'note_mention';

// Profile edits and remarks are only for the contact details page's activity log: never in the chat timeline or
// anyone's bell (so the chat and the notifications stay exactly as they were)
const PROFILE_ONLY: ActivityType[] = ['contact_updated', 'remark_added', 'remark_edited', 'remark_deleted', 'message_sent', 'list_added', 'list_removed'];
// Customer messages already appear as bubbles, so they're only in the bell, not the chat timeline
const NOT_IN_TIMELINE: ActivityType[] = ['message_received', 'note_mention', ...PROFILE_ONLY];

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

// A short version of a message for activity lists (the bell, the contact's activity): the message itself is always
// stored in full; a shortened preview ends with "…", so it's never silently cut. Cut between whole characters, never
// inside an emoji (half an emoji is invalid text the database refuses, and the activity would be lost).
export function previewOf(text: string, max: number) {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : text;
}

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
    // Profile entries go only to the contact details page (its own event): not the chat timeline, not the bell
    if (PROFILE_ONLY.includes(e.type)) return emitToWorkspace(e.workspaceId, 'contact:activity', activity);
    // A mention: only the bell of the person mentioned (kept there, so it's seen after being offline too)
    if (e.type === 'note_mention') {
      const to = (e.data as { mentionedUserId?: unknown } | undefined)?.mentionedUserId;
      if (typeof to === 'string' && to !== e.actorId) emitToUser(e.workspaceId, to, 'notification:new', activity);
      return;
    }
    // Chat timelines (anyone who has the chat open) keep getting every event
    emitToWorkspace(e.workspaceId, 'activity:new', activity);
    // The bell is per person: owners/admins get everything; everyone else only what concerns them (their chats,
    // or an assignment naming them). The person who did it isn't notified of their own action.
    for (const userId of await notificationRecipients(e.workspaceId, e.conversationId, e.data))
      if (userId !== e.actorId) emitToUser(e.workspaceId, userId, 'notification:new', activity);
  } catch (err) {
    console.error('[activity] could not record', e.type, err);
    void logFailure('activity.failed', `Couldn't record the activity "${e.type}"`, err, { workspaceId: e.workspaceId, conversationId: e.conversationId ?? null });
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
  for (const c of await prisma.conversationCollaborator.findMany({ where: { conversationId }, select: { userId: true } })) recipients.add(c.userId);
  const named = data && typeof data === 'object' && !Array.isArray(data) ? (data as { assigneeUserId?: unknown }).assigneeUserId : undefined;
  if (typeof named === 'string') recipients.add(named);
  return [...recipients];
}

// What a person may see in their bell. Owners and admins: everything in the workspace. Everyone else: only events
// on chats currently assigned to them, or assignments that name them. Enforced here, not in the UI.
function visibleTo(userId: string, role: string): Prisma.ActivityEventWhereInput {
  if (isAdminRole(role)) return {};
  return {
    OR: [
      { conversation: { assignedTo: { userId } } },
      { conversation: { collaborators: { some: { userId } } } },
      { data: { path: '$.assigneeUserId', equals: userId } },
    ],
  };
}

// Bell: newest events done by someone else (or by customers) that this person may see, plus how many are unseen
export async function listNotifications({ userId, workspaceId }: AuthPayload, first = 30) {
  const notMine = { OR: [{ actorId: null }, { actorId: { not: userId } }] };
  const member = await prisma.member.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { notificationsSeenAt: true, role: true },
  });
  if (!member) return { items: [], unseen: 0, seenAt: null };
  const where: Prisma.ActivityEventWhereInput = {
    workspaceId,
    AND: [
      notMine,
      {
        OR: [
          { AND: [{ type: { notIn: [...PROFILE_ONLY, 'note_mention'] } }, visibleTo(userId, member.role)] },
          // mentions: only the person mentioned (admins don't get everyone else's)
          { type: 'note_mention', data: { path: '$.mentionedUserId', equals: userId } },
        ],
      },
    ],
  };
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
  const { _sum } = await prisma.conversation.aggregate({ where: { workspaceId, contact: { deletedAt: null } }, _sum: { unread: true } });
  return _sum.unread ?? 0;
}

// Contact details page: everything that happened with this customer's chat (customer messages and profile
// changes included), newest first
export async function listContactActivity(workspaceId: string, contactId: string, first = 300) {
  const conversation = await prisma.conversation.findFirst({ where: { workspaceId, contactId }, select: { id: true } });
  if (!(await prisma.contact.findFirst({ where: { id: contactId, workspaceId }, select: { id: true } }))) throw notFound('Contact');
  if (!conversation) return [];
  const rows = await prisma.activityEvent.findMany({
    where: { workspaceId, conversationId: conversation.id, type: { not: 'note_mention' } }, // mentions: the bell only
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(Math.max(first, 1), 500),
    include,
  });
  return Promise.all(rows.map(toActivity));
}
