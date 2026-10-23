import { type CountryCode, getCountries, getCountryCallingCode, isValidPhoneNumber, parsePhoneNumberFromString } from 'libphonenumber-js';

// Settings → General: the country picker beside "Phone number" and the "Your time zone" list. Both come from the
// platform (libphonenumber's country list, the browser's own country and time zone names), nothing hand-written.

export type PhoneCountry = { code: CountryCode; dial: string; name: string; flag: string };

// 🇦🇪 from "AE" (regional indicator letters)
export const flagOf = (code: string) => String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

let countries: PhoneCountry[] | null = null;
export function phoneCountries(locale = 'en'): PhoneCountry[] {
  if (countries) return countries;
  const names = new Intl.DisplayNames([locale], { type: 'region' });
  countries = getCountries()
    .map((code) => ({ code, dial: getCountryCallingCode(code), name: names.of(code) ?? code, flag: flagOf(code) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return countries;
}

// A customer's country for the chat header: the one set in their profile (saved by name), else the country of
// their WhatsApp number. dial is the calling code ("91") and flag its flag; both null for a name typed in before
// the Country dropdown. null when unknown.
export function contactCountry(country: string | null | undefined, waId: string): { dial: string | null; flag: string | null; name: string } | null {
  const set = country?.trim();
  if (set) {
    const c = phoneCountries().find((x) => x.name.toLowerCase() === set.toLowerCase());
    return c ? { dial: c.dial, flag: c.flag, name: c.name } : { dial: null, flag: null, name: set };
  }
  const code = parsePhoneNumberFromString(`+${waId}`)?.country;
  const c = code ? phoneCountries().find((x) => x.code === code) : undefined;
  return c ? { dial: c.dial, flag: c.flag, name: c.name } : null;
}

// Search in a "+91 India" list: a calling code ("+97", "971") matches by its digits, anything else by the name
export function filterDialCountries<C extends { value: string; label: string }>(list: C[], query: string) {
  const digits = query.trim().replace(/^\+/, '');
  if (/^\d+$/.test(digits)) return list.filter((c) => c.label.startsWith(`+${digits}`));
  return filterCountries(list, query);
}

// A saved number (E.164, e.g. +971501234567) as country + the number without its country code
export function splitPhone(e164: string | null | undefined, fallback: CountryCode = 'AE') {
  const n = e164 ? parsePhoneNumberFromString(e164) : undefined;
  if (!n) return { country: fallback, national: e164 ? e164.replace(/^\+/, '') : '' };
  return { country: (n.country ?? fallback) as CountryCode, national: String(n.nationalNumber) };
}

// Back to one string for the server (which validates and stores E.164); '' clears the number
// A pasted international number (+44 20 …) is kept as it is
export function joinPhone(country: CountryCode, national: string) {
  if (national.trim().startsWith('+')) return `+${national.replace(/[^\d]/g, '')}`;
  const digits = national.replace(/[^\d]/g, '').replace(/^0+/, '');
  return digits ? `+${getCountryCallingCode(country)}${digits}` : '';
}

// New chat: the number typed (with the chosen country, or a full +international one pasted) as WhatsApp's id (digits
// with country code, as the server stores it), or why it isn't a real number. The server checks it again.
export function newChatNumber(country: CountryCode, typed: string): { waId: string } | { problem: string } {
  const e164 = joinPhone(country, typed);
  if (!e164) return { problem: 'Enter the WhatsApp number' };
  if (!isValidPhoneNumber(e164)) return { problem: `${e164} isn't a valid number. Check the country code and the number.` };
  return { waId: e164.slice(1) };
}

export type TimeZoneOption = { value: string; label: string; offsetMinutes: number };

// Browsers still list some zones under their pre-rename IANA ids (backward links in the tz database); shown and
// saved under today's names so a search for "Kolkata" or "Kyiv" finds them
const RENAMED: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Europe/Kiev': 'Europe/Kyiv',
  'America/Godthab': 'America/Nuuk',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Pacific/Truk': 'Pacific/Chuuk',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Enderbury': 'Pacific/Kanton',
};
const isZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
// Today's name for a zone, when this browser knows it
export const currentZoneName = (tz: string) => (RENAMED[tz] && isZone(RENAMED[tz]) ? RENAMED[tz] : tz);

const offsetOf = (tz: string, at: Date) => {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
};
const formatOffset = (minutes: number) => {
  const a = Math.abs(minutes);
  return `UTC${minutes < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
};

// "(UTC+04:00) Gulf Standard Time (Dubai)", at today's offset (daylight saving included)
export function timeZoneLabel(tz: string, at = new Date(), locale = 'en-US') {
  const offset = offsetOf(tz, at);
  const long = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: 'long' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value;
  const city = tz === 'UTC' ? '' : tz.split('/').pop()!.replace(/_/g, ' ');
  const name = long && !/^GMT/.test(long) ? long : '';
  return `(${formatOffset(offset)}) ${[name, city && (name ? `(${city})` : city)].filter(Boolean).join(' ') || 'Coordinated Universal Time'}`;
}

// Every time zone the browser knows, west to east
export function timeZoneOptions(at = new Date()): TimeZoneOption[] {
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['Asia/Dubai'];
  const all = [...new Set([...(zones.includes('UTC') ? [] : ['UTC']), ...zones.map(currentZoneName)])];
  return all
    .map((value) => ({ value, label: timeZoneLabel(value, at), offsetMinutes: offsetOf(value, at) }))
    .sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.label.localeCompare(b.label));
}

// Search in the time zone list: every word typed must appear in the label or the zone id ("dubai", "gulf",
// "utc+04", "new york", "america/new_york")
export function filterTimeZones(options: TimeZoneOption[], query: string) {
  const words = query.toLowerCase().replace(/_/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return options;
  return options.filter((o) => {
    const text = `${o.label} ${o.value.replace(/_/g, ' ')}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

// Country search ("india", "ind", "+91", "AE"): names starting with it first, then a word starting with it, then
// anywhere in the name; the dial code and the ISO code match too
export function filterCountries<C extends { value: string; label: string }>(list: C[], query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  const name = (c: C) => c.label.replace(/^\S+\s/, '').toLowerCase(); // label is "🇮🇳 India (+91)"
  const rank = (c: C) => {
    const n = name(c);
    if (n.startsWith(q) || c.value.toLowerCase() === q) return 0;
    if (n.split(/[\s(-]+/).some((w) => w.startsWith(q))) return 1;
    if (n.includes(q)) return 2;
    return -1;
  };
  return list
    .map((c) => ({ c, r: rank(c) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r)
    .map((x) => x.c);
}
