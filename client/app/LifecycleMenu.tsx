'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { type ContactOption, fetchContactFieldOptions } from '@/lib/contacts';
import { useStagesChanged } from './inbox/StageMenu';

// Left menu → LIFECYCLE STAGES: the workspace's stages (Settings → Customer lifecycle) with their colours; one click
// shows the Inbox with only the chats at that stage. Follows renames, colours and new stages live. The section
// folds, and that is remembered on this device.
const KEY = 'support:lifecycleMenuOpen';
let rememberedOpen: boolean | null = null;
let cachedStages: ContactOption[] | null = null;

export function LifecycleMenu({ matches }: { matches: (label: string) => boolean }) {
  const pathname = usePathname();
  const current = useSearchParams().get('stage');
  const [stages, setStages] = useState<ContactOption[] | null>(cachedStages);
  const [open, setOpen] = useState(() => {
    if (rememberedOpen === null) {
      try {
        rememberedOpen = localStorage.getItem(KEY) !== '0';
      } catch {
        rememberedOpen = true;
      }
    }
    return rememberedOpen;
  });
  const load = (fresh: boolean) =>
    fetchContactFieldOptions(fresh)
      .then((o) => {
        cachedStages = o.leadStages;
        setStages(o.leadStages);
      })
      .catch(() => {});
  useEffect(() => {
    load(false);
  }, []);
  useStagesChanged(() => load(true));

  const shown = (stages ?? []).filter((s) => matches(s.label));
  if (stages && !shown.length) return null; // the menu search hides the section when no stage matches
  const toggle = () => {
    const next = !open;
    rememberedOpen = next;
    setOpen(next);
    try {
      localStorage.setItem(KEY, next ? '1' : '0');
    } catch {
      // private mode: just not remembered
    }
  };
  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-md px-2 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-faint hover:text-body"
      >
        Lifecycle stages
        <svg className={`h-3.5 w-3.5 transition-transform ${open ? '' : 'rotate-180'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m18 15-6-6-6 6" />
        </svg>
      </button>
      {open && (
        <nav aria-label="Lifecycle stages" className="space-y-0.5">
          {!stages && <p className="px-2.5 py-2 text-[11px] text-faint">Loading…</p>}
          {shown.map((s) => {
            const active = pathname === '/inbox' && current === s.value;
            return (
              <Link
                key={s.value}
                href={`/inbox?stage=${encodeURIComponent(s.value)}`}
                scroll={false}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs font-semibold transition ${active ? 'bg-secondary text-on-primary shadow-2xs' : 'text-body hover:bg-surface-strong'}`}
              >
                <span className="h-3.5 w-3.5 shrink-0 rounded-[4px]" style={{ backgroundColor: s.color ?? 'var(--color-line)' }} aria-hidden="true" />
                <span className="truncate">{s.label}</span>
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}
