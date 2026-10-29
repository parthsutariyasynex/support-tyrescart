'use client';

import { useEffect, useRef } from 'react';
import type { WorkspaceMember } from '@/lib/assignees';
import { AssigneeAvatar } from './assign';

// "Add note" → @: the workspace's teammates (name and email) above the message box; ↑↓ to move, Enter or Tab or a
// click to insert, Esc to close
export type MentionMember = WorkspaceMember & { color: string };

export function MentionMenu({
  members,
  loading,
  active,
  onHover,
  onPick,
}: {
  members: MentionMember[];
  loading: boolean;
  active: number;
  onHover: (index: number) => void;
  onPick: (member: MentionMember) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <div role="listbox" aria-label="Mention a teammate" className="absolute bottom-full left-3 mb-2 flex max-h-72 w-72 max-w-[calc(100%-24px)] flex-col overflow-hidden rounded-xl border border-line bg-surface text-xs shadow-xl">
      {members.length === 0 && <p className="px-3 py-3 text-muted">{loading ? 'Loading teammates…' : 'No teammate matches'}</p>}
      <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
        {members.map((m, i) => (
          <li key={m.id} data-index={i}>
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => onHover(i)}
              // mousedown, so the message box keeps focus
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(m);
              }}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${i === active ? 'bg-surface-muted' : 'hover:bg-surface-muted'}`}
            >
              <AssigneeAvatar assignee={m} userId={m.id} size="h-8 w-8 text-[12px]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-ink">{m.name}</span>
                <span className="block truncate text-[11px] text-muted">{m.email}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
