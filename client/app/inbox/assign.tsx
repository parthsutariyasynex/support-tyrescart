'use client';

import { useEffect, useRef, useState } from 'react';
import {
  type Assignee,
  type WorkspaceMember,
  assignConversation,
  fetchWorkspaceMembers,
} from '@/lib/assignees';
import type { Conversation } from '@/lib/inbox';
import { assignableMembers, otherAssigneesToList, roleStyle } from '@/lib/roles';
import { RoleBadge } from '../RoleBadge';

type AssigneeRef = NonNullable<Conversation['assignee']>;

export function PersonIcon({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

// Coloured initial, like a label dot but for a person
export function AssigneeAvatar({ assignee, size = 'h-5 w-5 text-[10px]' }: { assignee: Pick<AssigneeRef, 'name' | 'color'>; size?: string }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full font-bold text-on-primary ${size}`}
      style={{ backgroundColor: assignee.color }}
    >
      {assignee.name.charAt(0).toUpperCase()}
    </span>
  );
}

const inputClass =
  'w-full rounded-lg border border-line bg-surface-muted/70 px-3 py-1.5 text-xs text-ink-soft placeholder:text-faint outline-hidden focus:border-primary focus:bg-surface focus:ring-1 focus:ring-primary';

// Top-header "Assign" dropdown: assign the open chat to a person (click them again to unassign). Without a chat it just lists them.
export function AssignDropdown({
  conversation,
  assignees,
  meId,
  canAssignOthers,
  membersVersion,
  onAssigned,
}: {
  conversation?: Conversation;
  assignees: Assignee[];
  meId: string | null;
  // Supervisors and admins; agents may only take an unassigned chat or release their own (the server enforces it)
  canAssignOthers: boolean;
  // Bumped by the page when members join, leave or change role (Socket.IO): refetch while open
  membersVersion: number;
  onAssigned: (conversationId: string, assignee: Conversation['assignee']) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Workspace members (People)
  const [members, setMembers] = useState<WorkspaceMember[] | null>(null);
  // Messages shown after an action
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  function close() {
    setOpen(false);
    setError('');
    setNotice('');
    setQuery('');
  }

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        inputRef.current?.focus({ preventScroll: true });
      });
    }
  }, [open]);

  // Switching chats closes the menu
  useEffect(close, [conversation?.id]);

  // Preload workspace members on mount and refetch on membersVersion to prevent layout shifts on open
  useEffect(() => {
    let cancelled = false;
    fetchWorkspaceMembers()
      .then((list) => !cancelled && setMembers(list))
      .catch(() => !cancelled && setMembers((m) => m ?? []));
    return () => {
      cancelled = true;
    };
  }, [membersVersion]);

  // If opened before initial preload finished, ensure it fetches
  useEffect(() => {
    if (!open || members !== null) return;
    let cancelled = false;
    fetchWorkspaceMembers()
      .then((list) => !cancelled && setMembers(list))
      .catch(() => !cancelled && setMembers((m) => m ?? []));
    return () => {
      cancelled = true;
    };
  }, [open, members]);

  async function attempt(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Like a label checkbox: tick to assign, untick the ticked one to unassign (asks first). The menu stays open.
  function toggle(assigneeId: string) {
    if (!conversation) return;
    if (conversation.assignee?.id === assigneeId && !confirm(`Unassign ${conversation.assignee.name} from this chat?`)) return;
    attempt(async () => {
      const c = await assignConversation(conversation.id, conversation.assignee?.id === assigneeId ? null : assigneeId);
      onAssigned(c.id, c.assignee);
    });
  }

  // A person: the server assigns their linked assignee (creating it the first time)
  function toggleMember(userId: string) {
    if (!conversation) return;
    if (conversation.assignee?.userId === userId && !confirm(`Unassign ${conversation.assignee.name} from this chat?`)) return;
    attempt(async () => {
      const c =
        conversation.assignee?.userId === userId
          ? await assignConversation(conversation.id, null)
          : await assignConversation(conversation.id, null, userId);
      onAssigned(c.id, c.assignee);
    });
  }

  const term = query.trim();
  const matches = (name: string) => name.toLowerCase().includes(term.toLowerCase());
  // People who can be assigned chats: this workspace's owner, Supervisors and Agents (live from the API; removed
  // members aren't in it). Their linked assignee carries the count. Stale names (no current member behind them)
  // are listed below only while they still hold chats.
  const eligible = assignableMembers(members ?? []);
  const people = eligible.filter((m) => matches(m.name) || matches(m.email));
  const linkedTo = (userId: string) => assignees.find((a) => a.userId === userId);
  const visible = otherAssigneesToList(assignees, eligible).filter((a) => matches(a.name));



  const current = conversation?.assignee;
  const memberRole = (userId: string | null) => (userId ? members?.find((m) => m.id === userId)?.role : undefined);
  // Only owners and admins see the checkboxes and assign or unassign here. Supervisors and agents see the list
  // read-only and take new chats with "Assign to Me" on New Leads. The server enforces the same rule.
  const allowed = (_a: Assignee) => canAssignOthers;
  const allowedPerson = (_userId: string) => canAssignOthers;
  // const sectionTitle = (text: string) => <li className="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-faint">{text}</li>;

  return (
    <div ref={ref} className="relative">
      <button
        data-assign-dropdown
        onClick={() => (open ? close() : setOpen(true))}
        title={conversation ? 'Assign this chat' : 'Manage assignees'}
        className={`flex items-center gap-1.5 rounded-full border bg-surface py-1 pl-1.5 pr-2.5 text-xs hover:bg-surface-muted transition cursor-pointer w-28 justify-between shrink-0 ${open ? 'border-primary text-primary' : 'border-line text-muted'}`}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {current ? (
            <AssigneeAvatar assignee={current} />
          ) : (
            <span className="flex h-5 w-5 items-center justify-center text-faint shrink-0">
              <PersonIcon className="h-4 w-4" />
            </span>
          )}
          <span className="truncate font-medium">{current ? current.name : 'Assign'}</span>
        </div>
        <svg className="h-3 w-3 text-faint shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Assign chat"
          className={`absolute right-0 top-11 flex max-h-[70vh] w-64 max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-2xl border border-line bg-surface text-xs shadow-xl z-50`}
        >
          <div className="flex items-center justify-between border-b border-line-soft px-3 py-2">
            <span className="font-semibold text-ink">
              {conversation ? 'Assign chat' : 'Assignees'}
            </span>
            <button onClick={close} title="Close" className="text-faint hover:text-body-soft">
              ✕
            </button>
          </div>

          {error && <div className="mx-3 mt-2 rounded-lg bg-danger-soft px-2.5 py-1.5 text-danger">{error}</div>}
          {notice && !error && <div className="mx-3 mt-2 rounded-lg bg-success-soft px-2.5 py-1.5 text-success">{notice}</div>}

          {(
            <>
              <div className="p-2">
                <input
                  ref={inputRef}
                  value={query}
                  maxLength={50}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search names"
                  className={inputClass}
                />
              </div>
              <ul className="min-h-[140px] flex-1 overflow-y-auto pb-1">
                {members === null && !people.length && (
                  <li className="px-3 py-4 text-center text-muted">Loading people…</li>
                )}
                {/* {people.length > 0 && sectionTitle('People')} */}
                {people.map((m) => {
                  const linked = linkedTo(m.id);
                  const ok = allowedPerson(m.id);
                  const isAssigned = !!current?.userId && current.userId === m.id;
                  return (
                    <li key={`member:${m.id}`} className="flex items-center gap-1 px-1">
                      <button
                        disabled={busy || !conversation || !ok}
                        title={conversation && !ok ? 'Only admins can assign chats. Use Assign to Me on New Leads.' : undefined}
                        onClick={() => toggleMember(m.id)}
                        className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition disabled:cursor-default ${
                          isAssigned
                            ? 'bg-primary-subtle text-primary font-medium'
                            : 'hover:bg-surface-muted disabled:hover:bg-transparent'
                        } ${conversation && !ok ? 'opacity-50' : ''}`}
                      >
                        <AssigneeAvatar assignee={{ name: m.name, color: roleStyle(m.role).color }} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-body">{m.name}</span>
                            <RoleBadge role={m.role} />
                            {m.id === meId && <span className="text-[10px] text-faint">You</span>}
                          </span>
                          <span className="block truncate text-[10px] text-muted">{m.email}</span>
                        </span>
                        <span className="flex items-center gap-1 text-[10px] text-faint">
                          {isAssigned && <span className="font-bold text-primary">✓</span>}
                          <span>{linked?.conversationCount ?? 0}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
                {/* {people.length > 0 && visible.length > 0 && sectionTitle('Other assignees')} */}
                {visible.map((a) => {
                  const isAssigned = current?.id === a.id;
                  return (
                    <li key={a.id} className="flex items-center gap-1 px-1">
                      <button
                        disabled={busy || !conversation || !allowed(a)}
                        title={conversation && !allowed(a) ? 'Only admins can assign chats. Use Assign to Me on New Leads.' : undefined}
                        onClick={() => toggle(a.id)}
                        className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition disabled:cursor-default ${
                          isAssigned
                            ? 'bg-primary-subtle text-primary font-medium'
                            : 'hover:bg-surface-muted disabled:hover:bg-transparent'
                        } ${conversation && !allowed(a) ? 'opacity-50' : ''}`}
                      >
                        <AssigneeAvatar assignee={a} />
                        <span className="truncate text-body">{a.name}</span>
                        <RoleBadge role={memberRole(a.userId)} />
                        <span className="ml-auto flex items-center gap-1 text-[10px] text-faint">
                          {isAssigned && <span className="font-bold text-primary">✓</span>}
                          <span>{a.conversationCount}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
                {assignees.length === 0 && eligible.length === 0 && !term && (
                  <li className="px-3 py-2 text-muted">
                    No assignees yet.
                  </li>
                )}
                {visible.length === 0 && people.length === 0 && term && (
                  <li className="px-3 py-2 text-muted">No names match.</li>
                )}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
