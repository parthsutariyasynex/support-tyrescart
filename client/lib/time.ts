// Every date and time in the app is shown in Dubai time, whatever the viewer's device is set to.
// The API sends UTC ISO strings (e.g. 2026-10-10T10:16:20.992Z); only the display is converted, here.
// `locale` is left to the viewer's browser (undefined) except in tests; `now` is only passed by tests.
export const APP_TIME_ZONE = 'Asia/Dubai';

type When = string | number | Date;
const toDate = (when: When) => (when instanceof Date ? when : new Date(when));

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(locale: string | undefined, options: Intl.DateTimeFormatOptions) {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone: APP_TIME_ZONE, ...options });
    formatters.set(key, f);
  }
  return f;
}

// 14:16 (or 2:16 PM, depending on the viewer's locale)
export const formatTime = (when: When, locale?: string) =>
  formatter(locale, { hour: '2-digit', minute: '2-digit' }).format(toDate(when));

// 10 Oct 2026, 14:16
export const formatDateTime = (when: When, locale?: string) =>
  formatter(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(
    toDate(when),
  );

// The calendar day in Dubai as YYYY-MM-DD (for grouping and comparing days)
export function dayKey(when: When) {
  const parts = formatter('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(toDate(when));
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Whole Dubai calendar days from `when` to `now` (0 = same day, 1 = the day before)
function daysAgo(when: When, now: When) {
  const utcMidnight = (key: string) => {
    const [y, m, d] = key.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utcMidnight(dayKey(now)) - utcMidnight(dayKey(when))) / 86_400_000);
}

const sameYear = (when: When, now: When) => dayKey(when).slice(0, 4) === dayKey(now).slice(0, 4);

// 10 Oct (this year) or 10 Oct 2025
export const formatShortDate = (when: When, now: When = Date.now(), locale?: string) =>
  formatter(locale, sameYear(when, now) ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }).format(
    toDate(when),
  );

// Chat separators, WhatsApp style: Today, Yesterday, Sat, 10 Oct (this year) or Sat, 10 Oct 2025
export function dayLabel(when: When, now: When = Date.now(), locale?: string) {
  const days = daysAgo(when, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return formatter(
    locale,
    sameYear(when, now)
      ? { weekday: 'short', day: 'numeric', month: 'short' }
      : { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' },
  ).format(toDate(when));
}

// Conversation list: the time for today, "Yesterday", otherwise a short date
export function listTimestamp(when: When, now: When = Date.now(), locale?: string) {
  const days = daysAgo(when, now);
  if (days === 0) return formatTime(when, locale);
  if (days === 1) return 'Yesterday';
  return formatShortDate(when, now, locale);
}
