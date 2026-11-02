import { type CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';
import { flagOf } from './profileOptions';

export type NumberCountry = { code: CountryCode; flag: string; name: string };

const cache = new Map<string, NumberCountry | null>();
let names: Intl.DisplayNames | null = null;

// The country of a WhatsApp number ("971501234567", with or without "+"), from libphonenumber's metadata: shared
// calling codes (+1 US/CA/…, +7 RU/KZ, +44 GB/GG/JE/IM, …) resolve by the number itself. null for an invalid number
// or one that belongs to no single country (+800, +882, …), so no flag is shown then.
export function numberCountry(waId: string | null | undefined): NumberCountry | null {
  const digits = (waId ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (cache.has(digits)) return cache.get(digits)!;
  const parsed = parsePhoneNumberFromString(`+${digits}`);
  const code = parsed?.isValid() ? parsed.country : undefined;
  let result: NumberCountry | null = null;
  if (code) {
    try {
      names ??= new Intl.DisplayNames(['en'], { type: 'region' });
    } catch {
      /* no Intl.DisplayNames: fall back to the code */
    }
    result = { code, flag: flagOf(code), name: names?.of(code) ?? code };
  }
  cache.set(digits, result);
  return result;
}
