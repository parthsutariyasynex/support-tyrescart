'use client';

import { useEffect, useRef } from 'react';

// Sidebar "Search menu" box (⌘K / Ctrl+K focuses it): filters the menu items below it as you type. Esc or ✕ clears.
export function MenuSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-muted/60 px-3 py-1.5 text-xs text-ink-soft focus-within:border-primary focus-within:bg-surface">
      <svg className="h-3.5 w-3.5 shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        ref={inputRef}
        type="search"
        value={value}
        aria-label="Search menu"
        placeholder="Search menu..."
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            onChange('');
            inputRef.current?.blur();
          }
        }}
        className="w-full bg-transparent text-xs text-ink placeholder:text-faint outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button type="button" onClick={() => onChange('')} title="Clear" className="text-faint hover:text-body-soft">
          ✕
        </button>
      ) : (
        <span className="flex items-center gap-0.5 rounded border border-line bg-surface px-1 py-0.5 text-[9px] font-semibold text-faint">⌘K</span>
      )}
    </div>
  );
}
