'use client';

import { useEffect, useRef, useState } from 'react';

export type StatusFilter = 'all' | 'open' | 'snoozed' | 'closed';

const OPTIONS: { key: StatusFilter; label: string; dot: string | null }[] = [
  { key: 'all', label: 'All', dot: null },
  { key: 'open', label: 'Open', dot: '#16a34a' },
  { key: 'snoozed', label: 'Snoozed', dot: '#d97706' },
  { key: 'closed', label: 'Closed', dot: '#94a3b8' },
];

// "● Open ⌄" at the top of the chat list: All / Open / Snoozed / Closed with live counts
export function StatusMenu({
  value,
  onChange,
  counts,
}: {
  value: StatusFilter;
  onChange: (s: StatusFilter) => void;
  counts: { open: number; snoozed: number; closed: number } | null;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = OPTIONS.find((o) => o.key === value)!;
  const countOf = (k: StatusFilter) => (!counts ? null : k === 'all' ? counts.open + counts.snoozed + counts.closed : counts[k]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Status: ${current.label}`}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-full px-1.5 py-1 text-xs font-medium text-body hover:bg-surface-strong"
      >
        {current.dot && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: current.dot }} />}
        {current.label}
        <svg className={`h-3.5 w-3.5 text-primary transition ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <ul role="listbox" aria-label="Chat status" className="absolute left-0 top-8 z-50 w-44 rounded-2xl border border-line bg-surface p-1.5 text-xs shadow-xl">
          {OPTIONS.map((o) => {
            const selected = o.key === value;
            const n = countOf(o.key);
            return (
              <li key={o.key}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onChange(o.key);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] ${selected ? 'bg-primary-subtle text-primary' : 'text-body hover:bg-surface-muted'}`}
                >
                  {o.dot && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: o.dot }} />}
                  <span className="flex-1">{o.label}</span>
                  {n !== null && <span className="rounded-md border border-line bg-surface px-1.5 text-[11px] tabular-nums text-body-soft">{n}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
