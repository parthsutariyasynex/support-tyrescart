import { env } from '../env.js';
import { settingsOf } from './workspaceSettings.js';
import { prisma } from '../prisma.js';
import { emitToUser } from '../realtime.js';

// Reminders for chats waiting for attention, sent as assignment:reminder to each person (their own Socket.IO room):
//   assigned   - the assignee hasn't opened it since it was assigned, or it has unread customer messages
//                -> the assignee is reminded
//   unassigned - a chat a customer has messaged that nobody has claimed -> every active member is reminded,
//                even after someone's opened it to look (only claiming it, closing it or the customer going
//                quiet stops the reminders; opening it without claiming it does not)
// A chat is due ASSIGNMENT_REMINDER_MINUTES (default 5) after it became pending (assignedAt / last customer message)
// and again every ASSIGNMENT_REMINDER_MINUTES until it is resolved: opened/read, closed, snoozed, (re)assigned.
// The last reminder time is stored on the chat (reminderSentAt) and claimed with a compare-and-set update, so a
// server restart neither resets the timer nor sends the same reminder twice, even with overlapping checks.
// The server checks every 30 seconds. No message text is ever sent, only the customer's name.

export type ReminderKind = 'assigned' | 'unassigned';
export type ReminderChat = { conversationId: string; contactName: string; kind: ReminderKind; lastMessageAt: Date };

export const CHECK_EVERY_MS = 30_000;
const thresholdMs = (minutes = env.assignmentReminderMinutes) => Math.max(minutes, 0) * 60_000;

type Row = {
  id: string;
  workspaceId: string;
  unread: number;
  lastMessageAt: Date;
  lastInboundAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  assignedAt: Date | null;
  assigneeOpenedAt: Date | null;
  reminderSentAt: Date | null;
  contact: { name: string | null; waId: string };
  assignedTo: { userId: string; active: boolean } | null;
};

// When the chat started needing attention, or null if it doesn't
export function pendingSince(c: Pick<Row, 'unread' | 'lastInboundAt' | 'createdAt' | 'updatedAt' | 'assignedAt' | 'assigneeOpenedAt' | 'assignedTo'>): Date | null {
  if (c.assignedTo) {
    if (!c.assignedTo.active) return null;
    if (!c.assigneeOpenedAt) return c.assignedAt ?? c.updatedAt; // not opened since it was assigned
    if (c.unread > 0) return c.lastInboundAt ?? c.updatedAt; // opened, but new customer messages since
    return null;
  }
  // Unclaimed: pending since the customer's first message, regardless of unread (opening it to look isn't
  // claiming it, so that alone must not silence the reminder). No message ever received: nothing to claim.
  return c.lastInboundAt ?? (c.unread > 0 ? c.createdAt : null);
}

// Due now: pending for the threshold, and not reminded within the threshold (a reminder from an earlier episode,
// before the chat became pending again, doesn't count)
export function isDue(c: Parameters<typeof pendingSince>[0] & Pick<Row, 'reminderSentAt'>, now: Date, ms = thresholdMs()) {
  const since = pendingSince(c);
  if (!since || ms <= 0) return false;
  const from = c.reminderSentAt && c.reminderSentAt > since ? c.reminderSentAt : since;
  return now.getTime() - from.getTime() >= ms;
}

// Chats due now (all workspaces, or one). Read-only (claiming happens in sendAssignmentReminders).
export async function findChatsNeedingAttention(now = new Date(), msOrDefault?: number, workspaceId?: string) {
  const explicit = msOrDefault !== undefined;
  const ms = msOrDefault ?? thresholdMs();
  const rows: Row[] = await prisma.conversation.findMany({
    where: {
      ...(workspaceId ? { workspaceId } : {}),
      status: 'open',
      contact: { deletedAt: null },
      OR: [
        { assignedToId: { not: null }, OR: [{ assigneeOpenedAt: null }, { unread: { gt: 0 } }] },
        { assignedToId: null, OR: [{ lastInboundAt: { not: null } }, { unread: { gt: 0 } }] },
      ],
    },
    select: {
      id: true,
      workspaceId: true,
      unread: true,
      lastMessageAt: true,
      lastInboundAt: true,
      createdAt: true,
      updatedAt: true,
      assignedAt: true,
      assigneeOpenedAt: true,
      reminderSentAt: true,
      contact: { select: { name: true, waId: true } },
      assignedTo: { select: { userId: true, active: true } },
    },
  });
  if (explicit) return rows.filter((c) => isDue(c, now, ms));
  // Each workspace's own reminder time (Settings → Workspace preferences; 0 = off there)
  const minutes = new Map<string, number>();
  for (const id of new Set(rows.map((r) => r.workspaceId))) minutes.set(id, (await settingsOf(id)).reminderMinutes);
  return rows.filter((c) => isDue(c, now, thresholdMs(minutes.get(c.workspaceId) ?? env.assignmentReminderMinutes)));
}

async function recipients(workspaceId: string, c: Row, membersCache: Map<string, string[]>) {
  if (c.assignedTo) return [c.assignedTo.userId];
  let all = membersCache.get(workspaceId);
  if (!all) {
    all = (await prisma.member.findMany({ where: { workspaceId, active: true }, select: { userId: true } })).map((m) => m.userId);
    membersCache.set(workspaceId, all);
  }
  return all;
}

// One check: claims every due chat (compare-and-set on reminderSentAt) and sends one event per person listing their
// chats. Returns how many people were reminded. workspaceId limits it to one workspace (the dev trigger).
export async function sendAssignmentReminders(now = new Date(), ms?: number, workspaceId?: string) {
  const due = await findChatsNeedingAttention(now, ms, workspaceId);
  const byPerson = new Map<string, { workspaceId: string; userId: string; chats: ReminderChat[] }>();
  const membersCache = new Map<string, string[]>();
  for (const c of due) {
    const { count } = await prisma.conversation.updateMany({
      where: { id: c.id, reminderSentAt: c.reminderSentAt }, // nobody else claimed it since we read it
      data: { reminderSentAt: now },
    });
    if (!count) continue;
    const chat: ReminderChat = { conversationId: c.id, contactName: c.contact.name || `+${c.contact.waId}`, kind: c.assignedTo ? 'assigned' : 'unassigned', lastMessageAt: c.lastMessageAt };
    for (const userId of await recipients(c.workspaceId, c, membersCache)) {
      const key = `${c.workspaceId}:${userId}`;
      const entry = byPerson.get(key) ?? { workspaceId: c.workspaceId, userId, chats: [] };
      entry.chats.push(chat);
      byPerson.set(key, entry);
    }
  }
  for (const p of byPerson.values()) {
    p.chats.sort((a, b) => a.lastMessageAt.getTime() - b.lastMessageAt.getTime()); // quietest first
    emitToUser(p.workspaceId, p.userId, 'assignment:reminder', {
      at: now.toISOString(),
      chats: p.chats.map((c) => ({ conversationId: c.conversationId, contactName: c.contactName, kind: c.kind })),
    });
  }
  return byPerson.size;
}

// Starts the checks (every 30 seconds, or sooner for a short threshold); returns a function that stops them.
// 0 (or an invalid value) disables reminders. onTick (tests, logging) gets how many people were reminded.
export function startAssignmentReminders(minutes = env.assignmentReminderMinutes, onTick?: (reminded: number) => void, workspaceId?: string) {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.log('[reminders] off (ASSIGNMENT_REMINDER_MINUTES=0)');
    return () => {};
  }
  console.log(`[reminders] chats waiting ${minutes} min are reminded, then every ${minutes} min until resolved`);
  const ms = minutes * 60_000;
  // Each workspace's reminder time applies (Settings → Workspace preferences); `minutes` is the default and the pace
  const tick = () =>
    sendAssignmentReminders(new Date(), undefined, workspaceId)
      .then((n) => {
        if (n && !env.isProd) console.log(`[reminders] ${n} ${n === 1 ? 'person' : 'people'} reminded`);
        onTick?.(n);
      })
      .catch((err) => console.error('[reminders] check failed', err));
  const timer = setInterval(tick, Math.min(CHECK_EVERY_MS, ms));
  timer.unref(); // never keeps the process alive on its own
  return () => clearInterval(timer);
}
