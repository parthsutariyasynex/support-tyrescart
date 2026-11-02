import { numberCountry } from '@/lib/countryFlag';

// The flag of a customer's WhatsApp number (🇦🇪), with the country name on hover. Nothing for an invalid number or
// one with no single country. Flag emojis render on Windows too (see app/FlagEmojis).
export function CountryFlag({ waId, className = 'text-[13px]' }: { waId: string | null | undefined; className?: string }) {
  const c = numberCountry(waId);
  if (!c) return null;
  return (
    <span role="img" aria-label={c.name} title={c.name} className={`inline-block shrink-0 select-none leading-none ${className}`}>
      {c.flag}
    </span>
  );
}
