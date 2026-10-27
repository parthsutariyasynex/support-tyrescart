'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { countryFilterList, matchesCountryQuery, toggle } from '@/lib/chatFilters';
import type { PhoneCountry } from '@/lib/profileOptions';

// "Country code" in the Filter menu: search, then pick one or more countries. The Gulf countries come first, then
// every other country A–Z; a chat matches when the customer's WhatsApp number starts with that country's code.
export function CountryPanel({ selected, onChange }: { selected: string[]; onChange: (codes: string[]) => void }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const { gulf, others } = useMemo(countryFilterList, []);
  const shownGulf = gulf.filter((c) => matchesCountryQuery(c, query));
  const shownOthers = others.filter((c) => matchesCountryQuery(c, query));

  const row = (c: PhoneCountry) => {
    const on = selected.includes(c.code);
    return (
      <li key={c.code}>
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={on}
          onClick={() => onChange(toggle(selected, c.code))}
          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition ${on ? 'bg-primary-subtle' : 'hover:bg-surface-muted'}`}
        >
          <span className="text-base leading-none" aria-hidden="true">
            {c.flag}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{c.name}</span>
          <span className="shrink-0 text-[11px] text-faint">+{c.dial}</span>
          <span className="w-3 shrink-0 text-xs font-bold text-primary">{on ? '✓' : ''}</span>
        </button>
      </li>
    );
  };
  const heading = (text: string) => <li className="px-2.5 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-faint">{text}</li>;

  return (
    <div className="ml-1 flex max-h-96 w-72 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-xl">
      <div className="p-2.5">
        <div className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 focus-within:border-primary">
          <svg className="h-4 w-4 shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search country or code"
            aria-label="Search countries"
            className="w-full bg-transparent text-[13px] text-ink placeholder:text-faint outline-none"
          />
        </div>
      </div>
      <ul className="flex-1 overflow-y-auto px-1.5 pb-1.5">
        {shownGulf.length > 0 && heading('Gulf countries')}
        {shownGulf.map(row)}
        {shownOthers.length > 0 && heading('All countries')}
        {shownOthers.map(row)}
        {!shownGulf.length && !shownOthers.length && <li className="px-2.5 py-3 text-center text-xs text-muted">No countries match</li>}
      </ul>
      <div className="border-t border-line-soft px-3 py-2">
        <button
          type="button"
          disabled={!selected.length}
          onClick={() => onChange([])}
          className="rounded-lg px-2 py-1 text-xs font-medium text-body-soft hover:bg-surface-muted disabled:opacity-40"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
