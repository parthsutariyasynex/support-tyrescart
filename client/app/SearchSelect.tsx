'use client';

import { useEffect, useRef, useState } from 'react';

// A dropdown with a search box on top, for long lists (e.g. "Your time zone"): the current choice and a chevron;
// opened, type to filter, ↑ ↓ Enter to choose, Esc or a click outside to close.
export function SearchSelect<T extends { value: string; label: string }>({
  id,
  value,
  options,
  onChange,
  filter,
  label,
  placeholder = 'Search',
  disabled,
}: {
  id?: string;
  value: string;
  options: readonly T[];
  onChange: (value: string) => void;
  filter: (options: T[], query: string) => T[];
  label: string; // for screen readers
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const current = options.find((o) => o.value === value);
  const shown = open ? filter([...options], query) : [];

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const onPointer = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const choose = (v: string) => {
    setOpen(false);
    if (v !== value) onChange(v);
  };

  return (
    <div ref={ref} className="relative">
      <button
        id={id}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${current?.label ?? value}`}
        className="flex w-full items-center gap-2 rounded-xl border border-line bg-input px-3.5 py-2.5 text-left text-sm text-ink transition hover:bg-surface focus:border-primary-hover focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="flex-1 truncate">{current?.label ?? value}</span>
        <svg className={`h-4 w-4 shrink-0 text-body-soft transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1.5 overflow-hidden rounded-xl border border-line bg-surface shadow-xl">
          <div className="border-b border-line-soft p-2">
            <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-muted/60 px-3 py-2 focus-within:border-primary focus-within:bg-surface">
              <svg className="h-3.5 w-3.5 shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                autoFocus
                type="search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActive((a) => Math.min(a + 1, shown.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActive((a) => Math.max(a - 1, 0));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (shown[active]) choose(shown[active].value);
                  } else if (e.key === 'Escape') {
                    // Only this dropdown closes, not a dialog it's in
                    e.preventDefault();
                    e.stopPropagation();
                    setOpen(false);
                  }
                }}
                placeholder={placeholder}
                aria-label={`Search ${label.toLowerCase()}`}
                className="w-full bg-transparent text-[13px] text-ink outline-hidden placeholder:text-faint"
              />
            </div>
          </div>
          <ul ref={list} role="listbox" aria-label={label} className="max-h-72 overflow-y-auto py-1">
            {shown.map((o, i) => {
              const selected = o.value === value;
              return (
                <li key={o.value} role="option" aria-selected={selected} data-index={i}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(o.value)}
                    className={`flex w-full items-center gap-2 px-3.5 py-2 text-left text-[13px] ${i === active ? 'bg-surface-muted' : ''} ${selected ? 'font-medium text-primary' : 'text-ink'}`}
                  >
                    <span className="flex-1">{o.label}</span>
                    {selected && (
                      <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    )}
                  </button>
                </li>
              );
            })}
            {!shown.length && <li className="px-3.5 py-3 text-xs text-faint">No matches</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
