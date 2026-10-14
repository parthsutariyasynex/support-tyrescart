import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { emitToUser } from '../realtime.js';

// Recurring assignment reminders. Every ASSIGNMENT_REMINDER_MINUTES (default 5) each assignee is reminded, over
// Socket.IO (assignment:reminder, to that user only), about every open chat assigned to them that they have not
// opened since it was assigned (Conversation.assigneeOpenedAt is null). A chat stops being reminded as soon as the
// assignee opens it, or it is closed, unassigned or reassigned (the next tick simply reads the live data; a
// reassigned chat starts again for the new assignee). Each person gets at most one event per tick, listing all
// their pending chats, so there are no duplicate reminders.

export type ReminderChat = { conversationId: string; contactName: string; lastMessageAt: Date };

// Open chats with an (active) assignee who hasn't opened them yet, grouped per (workspace, user)
export async function findChatsNeedingAttention() {
  const rows = await prisma.conversation.findMany({
    where: { status: 'open', assignedToId: { not: null }, assigneeOpenedAt: null, assignedTo: { active: true } },
    select: {
      id: true,
      workspaceId: true,
      lastMessageAt: true,
      contact: { select: { name: true, waId: true } },
      assignedTo: { select: { userId: true } },
    },
  });
  const byPerson = new Map<string, { workspaceId: string; userId: string; chats: ReminderChat[] }>();
  for (const c of rows) {
    if (!c.assignedTo) continue;
    const key = `${c.workspaceId}:${c.assignedTo.userId}`;
    const entry = byPerson.get(key) ?? { workspaceId: c.workspaceId, userId: c.assignedTo.userId, chats: [] };
    entry.chats.push({ conversationId: c.id, contactName: c.contact.name || `+${c.contact.waId}`, lastMessageAt: c.lastMessageAt });
    byPerson.set(key, entry);
  }
  for (const entry of byPerson.values()) entry.chats.sort((a, b) => a.lastMessageAt.getTime() - b.lastMessageAt.getTime()); // quietest first
  return [...byPerson.values()];
}

// One tick: sends every pending reminder. Returns how many people were reminded.
export async function sendAssignmentReminders(now = new Date()) {
  const pending = await findChatsNeedingAttention();
  for (const p of pending)
    emitToUser(p.workspaceId, p.userId, 'assignment:reminder', {
      at: now.toISOString(),
      chats: p.chats.map((c) => ({ conversationId: c.conversationId, contactName: c.contactName, lastMessageAt: c.lastMessageAt.toISOString() })),
    });
  return pending.length;
}

// Starts the schedule; returns a function that stops it. 0 (or an invalid value) disables reminders.
// onTick (tests, logging) is called after each tick with how many people were reminded.
export function startAssignmentReminders(minutes = env.assignmentReminderMinutes, onTick?: (reminded: number) => void) {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.log('[reminders] off (ASSIGNMENT_REMINDER_MINUTES=0)');
    return () => {};
  }
  console.log(`[reminders] every ${minutes} min: assignees are reminded about their open chats`);
  const tick = () =>
    sendAssignmentReminders()
      .then((n) => {
        if (!env.isProd) console.log(`[reminders] tick: ${n} ${n === 1 ? 'person' : 'people'} reminded`);
        onTick?.(n);
      })
      .catch((err) => console.error('[reminders] tick failed', err));
  const timer = setInterval(tick, minutes * 60_000);
  timer.unref(); // never keeps the process alive on its own
  return () => clearInterval(timer);
}
