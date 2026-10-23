'use client';

import { useEffect, useRef, useState } from 'react';
import { toggle } from '@/lib/chatFilters';
import { type ContactOption, fetchContactFieldOptions } from '@/lib/contacts';
import { useStagesChanged } from './StageMenu';

// "Stage" in the Filter menu: search, then pick one or more lifecycle stages (the workspace's, in lifecycle order,
// following Settings → Customer lifecycle changes live); Clear below
export function StagePanel({ selected, onChange }: { selected: string[]; onChange: (values: string[]) => void }) {
  const [stages, setStages] = useState<ContactOption[] | null>(null);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const load = (fresh: boolean) =>
    fetchContactFieldOptions(fresh)
      .then((o) => setStages(o.leadStages))
      .catch(() => setStages([]));
  useEffect(() => {
    inputRef.current?.focus();
    load(false);
  }, []);
  useStagesChanged(() => load(true));

  const term = query.trim().toLowerCase();
  const shown = (stages ?? []).filter((s) => !term || s.label.toLowerCase().includes(term));

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
            placeholder="Search"
            aria-label="Search stages"
            className="w-full bg-transparent text-[13px] text-ink placeholder:text-faint outline-none"
          />
        </div>
      </div>
      <ul className="flex-1 overflow-y-auto px-1.5 pb-1.5">
        {shown.map((s) => {
          const on = selected.includes(s.value);
          return (
            <li key={s.value}>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                onClick={() => onChange(toggle(selected, s.value))}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition ${on ? 'bg-primary-subtle' : 'hover:bg-surface-muted'}`}
              >
                <span
                  className="inline-flex max-w-[85%] truncate rounded-md px-2 py-0.5 text-[11px] font-semibold text-white"
                  style={{ backgroundColor: s.color ?? '#64748b' }}
                >
                  {s.label}
                </span>
                {on && <span className="ml-auto text-xs font-bold text-primary">✓</span>}
              </button>
            </li>
          );
        })}
        {stages === null && <li className="px-2.5 py-3 text-center text-xs text-muted">Loading…</li>}
        {stages !== null && shown.length === 0 && <li className="px-2.5 py-3 text-center text-xs text-muted">{term ? 'No stages match' : 'No stages yet'}</li>}
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
