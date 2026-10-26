'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { type ContactOption, STAGE_COUNTS_EVENT, fetchContactFieldOptions, fetchLeadStageCounts } from '@/lib/contacts';
import { revalidateOnReturn } from '@/lib/revalidate';
import { useStagesChanged } from './inbox/StageMenu';

// Left menu → LIFECYCLE STAGES (total): the workspace's stages (Settings → Customer lifecycle) with their colours and
// how many chats are at each, e.g. "New (3)"; one click shows the Inbox with only the chats at that stage. Follows
// renames, colours, new stages and the counts live. The section folds, and that is remembered on this device.
let cachedCounts: Record<string, number> | null = null;
const KEY = 'support:lifecycleMenuOpen';
let rememberedOpen: boolean | null = null;
let cachedStages: ContactOption[] | null = null;

export function LifecycleMenu({ matches }: { matches: (label: string) => boolean }) {
  const pathname = usePathname();
  const current = useSearchParams().get('stage');
  const [stages, setStages] = useState<ContactOption[] | null>(cachedStages);
  const [counts, setCounts] = useState<Record<string, number> | null>(cachedCounts);
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
  useStagesChanged(() => {
    load(true);
    loadCounts(); // a deleted stage moves its chats to another
  });

  // Chats per stage: on load, after anything that changes them (a quick burst counts once), and back on this tab
  const loadCounts = () =>
    fetchLeadStageCounts(true)
      .then((rows) => {
        cachedCounts = Object.fromEntries(rows.filter((r) => r.stage).map((r) => [r.stage!, r.count]));
        setCounts(cachedCounts);
      })
      .catch(() => {});
  useEffect(() => {
    loadCounts();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(loadCounts, 400);
    };
    window.addEventListener(STAGE_COUNTS_EVENT, soon);
    const stop = revalidateOnReturn(loadCounts);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(STAGE_COUNTS_EVENT, soon);
      stop();
    };
  }, []);

  const shown = (stages ?? []).filter((s) => matches(s.label));
  // All chats at a stage: the sum of the stages listed, so it always matches the numbers below
  const total = counts && stages ? stages.reduce((sum, s) => sum + (counts[s.value] ?? 0), 0) : null;
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
        <span>
          Lifecycle stages
          {total !== null && (
            <span className="ml-1 tabular-nums" aria-label={`${total} chats in all`}>
              ({total})
            </span>
          )}
        </span>
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
                {counts && (
                  <span className={`shrink-0 tabular-nums ${active ? 'text-on-primary/80' : 'text-faint'}`} aria-label={`${counts[s.value] ?? 0} chats`}>
                    ({counts[s.value] ?? 0})
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}
