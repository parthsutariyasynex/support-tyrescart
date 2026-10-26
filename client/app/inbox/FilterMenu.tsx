'use client';

import { useEffect, useRef, useState } from 'react';
import { type MenuFilters, EMPTY_MENU_FILTERS, activeFilterCount, toggle } from '@/lib/chatFilters';
import type { Assignee } from '@/lib/assignees';
import type { Label } from '@/lib/labels';
import { CollaboratorPanel } from './CollaboratorPanel';
import { DateRangePanel } from './DateRangePanel';
import { LabelsPanel } from './LabelsPanel';
import { StagePanel } from './StagePanel';

type Section = 'channel' | 'labels' | 'stage' | 'assign' | 'date';

const SECTIONS: { key: Section; label: string; icon: React.ReactNode }[] = [
  { key: 'channel', label: 'Channel', icon: <path d="M4.9 19.1a10 10 0 0 1 0-14.2M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M19.1 4.9a10 10 0 0 1 0 14.2M12 12h.01" /> },
  { key: 'labels', label: 'Labels', icon: <path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4zM7.5 7.5h.01" /> },
  { key: 'stage', label: 'Stage', icon: <path d="M3 3v18h18M7 16l4-4 4 4 5-6" /> },
  // Who the chat is assigned to
  { key: 'assign', label: 'Assign', icon: <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M16 11l2 2 4-4" /> },
  { key: 'date', label: 'Date range', icon: <path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" /> },
];

const Icon = ({ children }: { children: React.ReactNode }) => (
  <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

// "Filter" button + "Filter by" menu (Channel, Labels, Stage, Assign, Date range) with Clear all
export function FilterMenu({
  value,
  onChange,
  labels,
  assignees,
}: {
  value: MenuFilters;
  onChange: (f: MenuFilters) => void;
  labels: Pick<Label, 'id' | 'name' | 'color'>[];
  assignees: Pick<Assignee, 'id' | 'name' | 'color' | 'userId'>[];
}) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<Section | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const count = activeFilterCount(value);

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

  const selectedIn = (s: Section) =>
    s === 'labels' ? value.labelIds.length : s === 'stage' ? value.leadStages.length : s === 'assign' ? value.assigneeIds.length : s === 'date' ? (value.from || value.to ? 1 : 0) : 0;

  const check = (checked: boolean, onClick: () => void, children: React.ReactNode, key: string) => (
    <li key={key}>
      <button type="button" role="menuitemcheckbox" aria-checked={checked} onClick={onClick} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-body hover:bg-surface-muted">
        <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px] font-bold ${checked ? 'border-primary bg-primary text-on-primary' : 'border-line-strong'}`}>{checked ? '✓' : ''}</span>
        {children}
      </button>
    </li>
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          setSection(null);
        }}
        className={`flex w-[78px] items-center justify-between rounded-full px-2 py-1 text-[11px] font-medium hover:bg-surface-strong transition-colors ${count ? 'text-primary' : 'text-body-soft'}`}
      >
        <span className="flex items-center gap-1">
          <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18M7 12h10M10 18h4" />
          </svg>
          Filter
        </span>
        <span className="flex h-4 min-w-[16px] items-center justify-center">
          {count > 0 ? (
            <span className="rounded-full bg-primary px-1.5 text-[10px] font-bold text-on-primary">
              {count}
            </span>
          ) : null}
        </span>
      </button>

      {open && (
        <div role="menu" aria-label="Filter by" className="absolute left-0 top-8 z-50 flex items-start text-xs">
          <div className="w-60 rounded-2xl border border-line bg-surface p-2 shadow-xl">
            <div className="flex items-center justify-between px-2.5 pb-1.5 pt-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-faint">Filter by</span>
              <button type="button" disabled={!count} onClick={() => onChange(EMPTY_MENU_FILTERS)} className="text-[11px] font-medium text-muted hover:text-primary disabled:opacity-40">
                Clear all
              </button>
            </div>
            <ul>
              {SECTIONS.map((s) => (
                <li key={s.key}>
                  <button
                    type="button"
                    role="menuitem"
                    aria-expanded={section === s.key}
                    onClick={() => setSection((cur) => (cur === s.key ? null : s.key))}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-body hover:bg-surface-muted ${section === s.key ? 'bg-surface-muted' : ''}`}
                  >
                    <Icon>{s.icon}</Icon>
                    <span className="flex-1">{s.label}</span>
                    {selectedIn(s.key) > 0 && <span className="rounded-full bg-primary-subtle px-1.5 text-[10px] font-bold text-primary">{selectedIn(s.key)}</span>}
                    <svg className="h-3.5 w-3.5 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {section === 'date' && (
            <DateRangePanel key={`${value.from}|${value.to}`} from={value.from} to={value.to} onApply={(r) => onChange({ ...value, ...r })} />
          )}
          {section === 'assign' && (
            <CollaboratorPanel assignees={assignees} selected={value.assigneeIds} onChange={(ids) => onChange({ ...value, assigneeIds: ids })} />
          )}
          {section === 'labels' && <LabelsPanel labels={labels} selected={value.labelIds} onChange={(ids) => onChange({ ...value, labelIds: ids })} />}
          {section === 'stage' && <StagePanel selected={value.leadStages} onChange={(v) => onChange({ ...value, leadStages: v })} />}
          {section === 'channel' && (
            <div className="ml-1 max-h-80 w-56 overflow-y-auto rounded-2xl border border-line bg-surface p-2 shadow-xl">
              <p className="px-2.5 pb-1.5 pt-1 text-[10px] font-bold uppercase tracking-wider text-faint">{SECTIONS.find((s) => s.key === section)?.label}</p>
              <ul>
                {check(true, () => {}, <span>WhatsApp <span className="text-faint">(all chats)</span></span>, 'wa')}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
