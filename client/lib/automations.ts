import { gql } from './api';

// Settings → Company settings → Simple automations: automatic replies (during / outside working hours) and
// automatic assignment of new chats in turn. The server runs them for every customer message.
export type WorkingDay = { day: number; start: string; end: string }; // HH:MM; an end of 23:59 means until midnight
export type AutomationSettings = {
  enabled: boolean;
  workingDays: number[]; // 0 = Sunday … 6 = Saturday
  workStart: string; // HH:MM
  workEnd: string;
  workingHours: WorkingDay[]; // each working day (Monday first) with its own hours
  replyInHoursEnabled: boolean;
  replyInHours: string;
  replyOutHoursEnabled: boolean;
  replyOutHours: string;
  cooldownHours: number;
  routingEnabled: boolean;
  routingMode: 'specific' | 'round_robin' | 'unassigned';
  routingMemberIds: string[];
  routingOnlineOnly: boolean;
  timeZone: string;
  lastAutoReplyAt: string | null;
  variables: { key: string; label: string }[];
  replyMaxLength: number;
};
export type AutomationInput = Partial<Omit<AutomationSettings, 'timeZone' | 'lastAutoReplyAt' | 'variables' | 'replyMaxLength'>>;
const FIELDS = `enabled workingDays workStart workEnd workingHours { day start end } replyInHoursEnabled replyInHours replyOutHoursEnabled replyOutHours cooldownHours
  routingEnabled routingMode routingMemberIds routingOnlineOnly
  timeZone lastAutoReplyAt variables { key label } replyMaxLength`;

export async function fetchAutomationSettings() {
  return (await gql<{ automationSettings: AutomationSettings }>(`{ automationSettings { ${FIELDS} } }`)).automationSettings;
}
export async function updateAutomationSettings(input: AutomationInput) {
  return (await gql<{ updateAutomationSettings: AutomationSettings }>(`mutation SaveAutomations($i: AutomationSettingsInput!) { updateAutomationSettings(input: $i) { ${FIELDS} } }`, { i: input }))
    .updateAutomationSettings;
}

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// "9:00 AM"
export function clock(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
// "GMT+4" for a time zone, now
export function gmtOffset(timeZone: string, at = new Date()) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value;
  return name ?? 'GMT';
}
export const WEEK = [1, 2, 3, 4, 5, 6, 0]; // Monday first, as in SleekFlow
export const allDay = (h: Pick<WorkingDay, 'start' | 'end'>) => h.start === '00:00' && h.end === '23:59';
// "Mon, Tue, Wed, Thu, Fri, Sat 9:00 AM - 6:00 PM (GMT+4)"; days with different hours are listed separately:
// "Mon, Tue 9:00 AM - 6:00 PM · Sat 10:00 AM - 2:00 PM (GMT+4)"
export function workingHoursText(s: Pick<AutomationSettings, 'workingHours' | 'timeZone'>, at = new Date()) {
  const groups: { days: number[]; start: string; end: string }[] = [];
  for (const d of WEEK) {
    const h = s.workingHours.find((x) => x.day === d);
    if (!h) continue;
    const same = groups.find((g) => g.start === h.start && g.end === h.end);
    if (same) same.days.push(d);
    else groups.push({ days: [d], start: h.start, end: h.end });
  }
  if (!groups.length) return `Closed every day (${gmtOffset(s.timeZone, at)})`;
  if (groups.length === 1 && groups[0].days.length === 7 && allDay(groups[0])) return `Every day, 24 hours (${gmtOffset(s.timeZone, at)})`;
  const text = groups.map((g) => `${g.days.map((d) => DAY_NAMES[d]).join(', ')} ${allDay(g) ? '24 hours' : `${clock(g.start)} - ${clock(g.end)}`}`).join(' · ');
  return `${text} (${gmtOffset(s.timeZone, at)})`;
}
