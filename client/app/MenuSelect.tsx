'use client';

import { useEffect, useRef, useState } from 'react';

// A small dropdown like "All types ⌄": the current choice and a chevron (up while open), and a white menu with the
// selected option in the brand colour. Closes on choosing, clicking outside or Esc; ↑ ↓ Enter work.
export function MenuSelect({
  value,
  options,
  onChange,
  label,
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  label: string; // for screen readers, e.g. "Filter media by type"
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const onPointer = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open, options, value]);

  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <div
      ref={ref}
      className="relative"
      onKeyDown={(e) => {
        if (!open) return;
        if (e.key === 'Escape') setOpen(false);
        else if (e.key === 'ArrowDown') {
          e.preventDefault();
          setActive((i) => Math.min(i + 1, options.length - 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActive((i) => Math.max(i - 1, 0));
        } else if (e.key === 'Enter') {
          e.preventDefault();
          choose(options[active].value);
        }
      }}
    >
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[13px] text-body transition hover:bg-surface-muted"
      >
        {current?.label}
        <svg className={`h-3.5 w-3.5 text-body-soft transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <ul role="listbox" aria-label={label} className="absolute left-0 top-full z-30 mt-1.5 min-w-[120px] overflow-hidden rounded-lg border border-line-soft bg-surface py-1 shadow-xl">
          {options.map((o, i) => {
            const selected = o.value === value;
            return (
              <li key={o.value} role="option" aria-selected={selected}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(o.value)}
                  className={`block w-full whitespace-nowrap px-3 py-2.5 text-left text-[13px] transition ${selected ? 'text-primary' : 'text-ink'} ${i === active ? 'bg-surface-muted' : ''}`}
                >
                  {o.label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
