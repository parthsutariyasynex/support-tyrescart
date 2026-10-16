import { currentTimeZone, formatTime } from './time';

// Snooze choices in the chat menu, as absolute times from `now`. "Tomorrow 9:00" and "Monday 9:00" are 9:00 in the
// app's time zone (Dubai unless changed in Settings), like every other time shown in the app, whatever the viewer's device is set to.
export type SnoozeChoice = { key: string; label: string; until: Date };

// The calendar date and weekday in the app time zone
function zonedParts(d: Date, timeZone = currentTimeZone()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), weekday, hour: Number(parts.hour), minute: Number(parts.minute) };
}

// The instant that is `hour:00` on the given calendar day in the app time zone
export function zonedAt(year: number, month: number, day: number, hour: number, timeZone = currentTimeZone()) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour));
  const p = zonedParts(guess, timeZone);
  const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return new Date(guess.getTime() - (shown - guess.getTime()));
}

// "Tomorrow" and "Monday" wake at the start of the business day (Settings → Workspace preferences; 9:00 by default)
let businessDayStartHour = 9;
export function setBusinessDayStart(hour: number | null | undefined) {
  businessDayStartHour = Number.isInteger(hour) && hour! >= 0 && hour! <= 23 ? hour! : 9;
}

export function snoozeChoices(now = new Date(), timeZone = currentTimeZone()): SnoozeChoice[] {
  const today = zonedParts(now, timeZone);
  const dayPlus = (n: number) => {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + n));
    return zonedAt(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), businessDayStartHour, timeZone);
  };
  const daysToMonday = ((8 - today.weekday) % 7) || 7; // next Monday, never today
  return [
    { key: '1h', label: '1 hour', until: new Date(now.getTime() + 3600_000) },
    { key: '3h', label: '3 hours', until: new Date(now.getTime() + 3 * 3600_000) },
    { key: 'tomorrow', label: 'Tomorrow', until: dayPlus(1) },
    { key: 'monday', label: 'Monday', until: dayPlus(daysToMonday) },
  ];
}

// "15 Oct, 14:16" in the app time zone
export function snoozedUntilText(iso: string | null | undefined, locale?: string) {
  if (!iso) return '';
  const day = new Intl.DateTimeFormat(locale, { timeZone: currentTimeZone(), day: 'numeric', month: 'short' }).format(new Date(iso));
  return `${day}, ${formatTime(iso, locale)}`;
}
