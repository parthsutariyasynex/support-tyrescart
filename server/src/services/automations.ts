import { z } from 'zod';
import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { listPresence } from '../presence.js';
import { emitToWorkspace } from '../realtime.js';
import { sendText } from '../whatsapp.js';
import { assignConversation } from './assign.js';
import { AppError } from './errors.js';
import { requireAdmin } from './permissions.js';
import { withSender } from './senders.js';
import { parse } from './validate.js';
import { fillVariables, listVariables, resolveKey, variableValues, variablesIn } from './variables.js';
import { settingsOf } from './workspaceSettings.js';
import { windowOpen } from './messagingWindow.js';

// Settings → Company settings → Simple automations. When a customer writes:
//  1. routing: a chat nobody holds is assigned to the next of the chosen members, in turn (optionally only to
//     those online right now);
//  2. auto-reply: one text during working hours, another outside them, filled in with the customer's details.
//     A chat gets at most one automatic reply per cooldown, so a conversation isn't answered on every message.
// Working hours use the workspace's default time zone (Workspace preferences). Nothing runs while disabled, and
// nothing here can stop an incoming message from being saved (failures are only logged).

// Automatic replies go out as WhatsApp text messages: WhatsApp's own limit (4096 characters), no lower app limit
export const REPLY_MAX = 4096;

// --- Pure rules

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
export type WorkingDay = { day: number; start: string; end: string };
const WEEK = [1, 2, 3, 4, 5, 6, 0]; // Monday first, as the settings page shows it
const readDayHours = (json: string | null | undefined): Record<string, string> => {
  try {
    const v = JSON.parse(json ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};
// Each working day with its hours: its own (dayHours) or the shared workStart-workEnd
export function workingHoursOf(s: { workingDays: string; workStart: string; workEnd: string; dayHours?: string | null }): WorkingDay[] {
  const days = s.workingDays.split(',').filter(Boolean).map(Number);
  const own = readDayHours(s.dayHours);
  return WEEK.filter((d) => days.includes(d)).map((day) => {
    const [start, end] = /^\d\d:\d\d-\d\d:\d\d$/.test(own[day] ?? '') ? own[day].split('-') : [s.workStart, s.workEnd];
    return { day, start, end };
  });
}

// Is `now` within the working days and hours, in `timeZone`? (end is exclusive: 18:00 means until 17:59; 23:59 means until midnight)
export function withinWorkingHours(s: { workingDays: string; workStart: string; workEnd: string; dayHours?: string | null }, timeZone: string, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const hours = workingHoursOf(s).find((h) => h.day === day);
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return !!hours && minute >= toMinutes(hours.start) && (minute < toMinutes(hours.end) || hours.end === '23:59');
}

// The member after `last` in the list (wrapping round), among those `eligible`; null if nobody is
export function nextInTurn(order: string[], eligible: Set<string>, last: string | null) {
  const start = last ? order.indexOf(last) + 1 : 0;
  for (let i = 0; i < order.length; i++) {
    const id = order[(start + i) % order.length];
    if (eligible.has(id)) return id;
  }
  return null;
}

// --- Settings (admins)

// Route conversations: one teammate gets every new chat, or chosen teammates in turn, or chats stay unassigned
export const ROUTING_MODES = ['specific', 'round_robin', 'unassigned'] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

const DEFAULTS = {
  enabled: false,
  workingDays: '1,2,3,4,5',
  workStart: '09:00',
  workEnd: '18:00',
  dayHours: null as string | null,
  replyInHoursEnabled: false,
  replyInHours: '',
  replyOutHoursEnabled: false,
  replyOutHours: '',
  cooldownHours: 24,
  routingEnabled: false,
  routingMode: 'round_robin' as RoutingMode,
  routingMemberIds: [] as string[],
  routingOnlineOnly: false,
};
type Row = Awaited<ReturnType<typeof prisma.automationSettings.findUnique>>;
const readIds = (json: string | null | undefined) => {
  try {
    const v = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const toSettings = (row: Row) =>
  row
    ? {
        ...DEFAULTS,
        ...row,
        replyInHours: row.replyInHours ?? '',
        replyOutHours: row.replyOutHours ?? '',
        routingMemberIds: readIds(row.routingMemberIds),
      }
    : { ...DEFAULTS };

export async function getAutomationSettings(auth: AuthPayload) {
  await requireAdmin(auth);
  const lastOf = (automation: string) =>
    prisma.message.findFirst({ where: { automation, conversation: { workspaceId: auth.workspaceId } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  const [row, last, ws, variables] = await Promise.all([
    prisma.automationSettings.findUnique({ where: { workspaceId: auth.workspaceId } }),
    lastOf('auto_reply'),
    settingsOf(auth.workspaceId),
    listVariables(auth.workspaceId),
  ]);
  return { ...toSettings(row), timeZone: ws.defaultTimeZone, lastAutoReplyAt: last?.createdAt ?? null, variables };
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 09:00');
const updateSchema = z
  .object({
    enabled: z.boolean().optional(),
    workingDays: z
      .array(z.number().int().min(0).max(6))
      .min(1, 'Choose at least one working day')
      .transform((d) => [...new Set(d)].sort().join(','))
      .optional(),
    workStart: hhmm.optional(),
    workEnd: hhmm.optional(),
    // Each working day with its own hours (replaces workingDays/workStart/workEnd)
    workingHours: z
      .array(z.object({ day: z.number().int().min(0).max(6), start: hhmm, end: hhmm }))
      .min(1, 'Choose at least one working day')
      .max(7)
      .optional(),
    replyInHoursEnabled: z.boolean().optional(),
    replyInHours: z.string().trim().max(REPLY_MAX, `Replies can be up to ${REPLY_MAX} characters`).optional(),
    replyOutHoursEnabled: z.boolean().optional(),
    replyOutHours: z.string().trim().max(REPLY_MAX, `Replies can be up to ${REPLY_MAX} characters`).optional(),
    cooldownHours: z.number().int().min(1, 'At least 1 hour').max(168, 'Up to 168 hours (a week)').optional(),
    routingEnabled: z.boolean().optional(),
    routingMode: z.enum(ROUTING_MODES, { message: 'Choose how new chats are routed' }).optional(),
    routingMemberIds: z.array(z.string().min(1)).max(200).optional(),
    routingOnlineOnly: z.boolean().optional(),
  })
  .superRefine((s, ctx) => {
    if (s.workStart && s.workEnd && toMinutes(s.workEnd) <= toMinutes(s.workStart)) ctx.addIssue({ code: 'custom', message: 'Working hours must end after they start' });
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    for (const h of s.workingHours ?? [])
      if (toMinutes(h.end) <= toMinutes(h.start)) ctx.addIssue({ code: 'custom', message: `${names[h.day]}: working hours must end after they start` });
    if (s.workingHours && new Set(s.workingHours.map((h) => h.day)).size !== s.workingHours.length) ctx.addIssue({ code: 'custom', message: 'Each day can be listed once' });
  });

export async function updateAutomationSettings(auth: AuthPayload, rawInput: unknown) {
  await requireAdmin(auth);
  const input = parse(updateSchema, rawInput ?? {});
  const current = toSettings(await prisma.automationSettings.findUnique({ where: { workspaceId: auth.workspaceId } }));
  const { workingHours, ...rest } = input;
  const next = { ...current, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) } as typeof current;
  if (workingHours) {
    const list = WEEK.map((d) => workingHours.find((h) => h.day === d)).filter((h) => !!h);
    next.workingDays = list.map((h) => h.day).sort().join(',');
    next.workStart = list[0].start;
    next.workEnd = list[0].end;
    next.dayHours = JSON.stringify(Object.fromEntries(list.map((h) => [h.day, `${h.start}-${h.end}`])));
  } else if (input.workingDays || input.workStart || input.workEnd) next.dayHours = null; // one set of hours for every day again
  if (toMinutes(next.workEnd) <= toMinutes(next.workStart)) throw new AppError('Working hours must end after they start', 400, 'BAD_USER_INPUT');
  if (next.replyInHoursEnabled && !next.replyInHours.trim()) throw new AppError('Write the reply for working hours, or turn it off', 400, 'BAD_USER_INPUT');
  if (next.replyOutHoursEnabled && !next.replyOutHours.trim()) throw new AppError('Write the reply for outside working hours, or turn it off', 400, 'BAD_USER_INPUT');
  if (input.routingMemberIds) {
    const members = await prisma.member.findMany({ where: { workspaceId: auth.workspaceId, id: { in: input.routingMemberIds }, active: true }, select: { id: true } });
    if (members.length !== new Set(input.routingMemberIds).size) throw new AppError('Choose active members of this workspace', 400, 'BAD_USER_INPUT');
  }
  // Every {{variable}} must be one this workspace has (or a short form of exactly one), so a typo isn't sent blank
  const known = (await listVariables(auth.workspaceId)).map((v) => v.key);
  for (const text of [next.replyInHours, next.replyOutHours]) {
    const unknown = variablesIn(text).filter((k) => !resolveKey(k, known));
    if (unknown.length) throw new AppError(`Unknown variable ${unknown.map((k) => `{{${k}}}`).join(', ')}. Insert variables with the (x) button.`, 400, 'BAD_USER_INPUT');
  }
  if (next.routingEnabled && next.routingMode === 'specific' && next.routingMemberIds.length !== 1)
    throw new AppError('Choose the teammate who gets every new chat', 400, 'BAD_USER_INPUT');
  if (next.routingEnabled && next.routingMode === 'round_robin' && !next.routingMemberIds.length)
    throw new AppError('Choose the teammates new chats are shared between', 400, 'BAD_USER_INPUT');
  const data = {
    enabled: next.enabled,
    workingDays: next.workingDays,
    workStart: next.workStart,
    workEnd: next.workEnd,
    dayHours: next.dayHours,
    replyInHoursEnabled: next.replyInHoursEnabled,
    replyInHours: next.replyInHours || null,
    replyOutHoursEnabled: next.replyOutHoursEnabled,
    replyOutHours: next.replyOutHours || null,
    cooldownHours: next.cooldownHours,
    routingEnabled: next.routingEnabled,
    routingMode: next.routingMode,
    routingMemberIds: JSON.stringify([...new Set(next.routingMemberIds)]),
    routingOnlineOnly: next.routingOnlineOnly,
    updatedBy: auth.userId,
  };
  await prisma.automationSettings.upsert({ where: { workspaceId: auth.workspaceId }, update: data, create: { workspaceId: auth.workspaceId, ...data, createdBy: auth.userId } });
  return getAutomationSettings(auth);
}

// --- Running (called for every customer message)

export async function runAutomations(workspaceId: string, conversationId: string, now = new Date()) {
  const row = await prisma.automationSettings.findUnique({ where: { workspaceId } });
  if (!row?.enabled) return { assigned: null as string | null, replied: null as string | null };
  const s = toSettings(row);
  let assigned: string | null = null;
  let replied: string | null = null;

  // 1. Routing: only a chat nobody holds. Specific: always that teammate (if still active); round robin: the next
  // eligible one in turn; unassigned: nothing (the chat waits in New Leads)
  if (s.routingEnabled && s.routingMode !== 'unassigned' && s.routingMemberIds.length) {
    try {
      const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { assignedToId: true } });
      if (conv && !conv.assignedToId) {
        const members = await prisma.member.findMany({ where: { workspaceId, id: { in: s.routingMemberIds }, active: true }, select: { id: true, userId: true } });
        const online = s.routingOnlineOnly ? new Set(listPresence(workspaceId).filter((p) => p.status === 'online').map((p) => p.userId)) : null;
        const eligible = new Set(members.filter((m) => s.routingMode === 'specific' || !online || online.has(m.userId)).map((m) => m.id));
        const next = s.routingMode === 'specific' ? (eligible.has(s.routingMemberIds[0]) ? s.routingMemberIds[0] : null) : nextInTurn(s.routingMemberIds, eligible, row.routingLastMemberId);
        if (next) {
          await assignConversation(workspaceId, conversationId, next, null, { reason: 'Simple automations: routing', actorLabel: 'Simple automations' });
          await prisma.automationSettings.update({ where: { workspaceId }, data: { routingLastMemberId: next } });
          assigned = next;
        }
      }
    } catch (err) {
      console.error('[automations] routing failed', conversationId, (err as Error).message);
    }
  }

  // 2. Auto-reply
  try {
    const tz = (await settingsOf(workspaceId)).defaultTimeZone;
    const inHours = withinWorkingHours(s, tz, now);
    const text = inHours ? (s.replyInHoursEnabled ? s.replyInHours : '') : s.replyOutHoursEnabled ? s.replyOutHours : '';
    const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { contact: true } });
    const recently = conv?.lastAutoReplyAt && now.getTime() - conv.lastAutoReplyAt.getTime() < s.cooldownHours * 3_600_000;
    const account = text && conv && !recently ? await prisma.whatsAppAccount.findUnique({ where: { workspaceId } }) : null;
    // Only inside WhatsApp's 24-hour window (a webhook Meta delivers late can be from a customer who wrote over a day ago)
    if (text && conv && !recently && account && conv.status !== 'closed' && windowOpen(conv.lastInboundAt, now.getTime())) {
      const body = fillVariables(text, await variableValues(workspaceId, conversationId));
      // Claimed first (compare-and-set on lastAutoReplyAt), so two messages arriving together send one reply
      const { count } = await prisma.conversation.updateMany({ where: { id: conversationId, lastAutoReplyAt: conv.lastAutoReplyAt }, data: { lastAutoReplyAt: now } });
      if (count) {
        const message = await prisma.message.create({ data: { conversationId, direction: 'out', type: 'text', body, status: 'pending', automation: 'auto_reply' } });
        let saved;
        try {
          const wamid = await sendText(account, conv.contact.waId, body);
          saved = await prisma.message.update({ where: { id: message.id }, data: { waMessageId: wamid, status: 'sent' } });
        } catch (err) {
          saved = await prisma.message.update({ where: { id: message.id }, data: { status: 'failed', error: (err as Error).message } });
        }
        await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });
        const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { contact: true } });
        emitToWorkspace(workspaceId, 'message:new', { conversation, message: await withSender(saved) });
        replied = saved.id;
      }
    }
  } catch (err) {
    console.error('[automations] auto-reply failed', conversationId, (err as Error).message);
  }
  return { assigned, replied };
}
