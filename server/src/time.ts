// The app shows and reasons about every date and time in Dubai time (Asia/Dubai, UTC+4, no daylight saving),
// whatever the server's or database's own time zone is. Timestamps are still stored in UTC.
export const APP_TIME_ZONE = 'Asia/Dubai';

const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'longOffset',
});

// 2026-10-21T07:30:00.000Z -> "2026-10-21T11:30:00+04:00" (Dubai wall time with its offset; still exact and sortable)
export function dubaiIso(at: Date) {
  const p = Object.fromEntries(parts.formatToParts(at).map((x) => [x.type, x.value]));
  const offset = p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName.replace('GMT', '');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}

// The calendar day in Dubai, YYYY-MM-DD
export const dubaiDay = (at: Date) => dubaiIso(at).slice(0, 10);
