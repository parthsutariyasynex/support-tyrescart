'use client';

import { useEffect, useRef, useState } from 'react';
import { type Assignee, type WorkspaceMember, fetchWorkspaceMembers } from '@/lib/assignees';
import { toggle } from '@/lib/chatFilters';

// "Assign" in the Filter menu: search, then pick one or more people the chats are assigned to; Clear below.
// Names and colours come from the assignee list, emails from the live member list.
export function CollaboratorPanel({
  assignees,
  selected,
  onChange,
}: {
  assignees: Pick<Assignee, 'id' | 'name' | 'color' | 'userId'>[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    let cancelled = false;
    fetchWorkspaceMembers()
      .then((list) => !cancelled && setMembers(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const emailOf = (userId: string | null) => (userId ? members.find((m) => m.id === userId)?.email : undefined) ?? '';
  const term = query.trim().toLowerCase();
  const people = assignees
    .map((a) => ({ ...a, email: emailOf(a.userId) }))
    .filter((a) => !term || a.name.toLowerCase().includes(term) || a.email.toLowerCase().includes(term))
    .sort((a, b) => a.name.localeCompare(b.name));

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
            aria-label="Search assignees"
            className="w-full bg-transparent text-[13px] text-ink placeholder:text-faint outline-none"
          />
        </div>
      </div>
      <ul className="flex-1 overflow-y-auto px-1.5 pb-1.5">
        {people.map((p) => {
          const on = selected.includes(p.id);
          return (
            <li key={p.id}>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                onClick={() => onChange(toggle(selected, p.id))}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition ${on ? 'bg-primary-subtle' : 'hover:bg-surface-muted'}`}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-on-primary" style={{ backgroundColor: p.color }}>
                  {p.name.charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">{p.name}</span>
                  {p.email && <span className="block truncate text-[11px] text-muted">{p.email}</span>}
                </span>
                {on && <span className="text-xs font-bold text-primary">✓</span>}
              </button>
            </li>
          );
        })}
        {people.length === 0 && <li className="px-2.5 py-3 text-center text-xs text-muted">{term ? 'No one matches' : 'No people yet'}</li>}
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
