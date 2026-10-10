'use client';

import { useEffect, useRef, useState } from 'react';
import { type Assignee, assignConversation, createAssignee, deleteAssignee, updateAssignee } from '@/lib/assignees';
import type { Conversation } from '@/lib/inbox';
import { LABEL_COLORS } from '@/lib/labels';
import { ColorField } from './colors';

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
export function AssigneeAvatar({ assignee, size = 'h-5 w-5 text-[10px]' }: { assignee: AssigneeRef; size?: string }) {
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

// Top-header "Assign" dropdown: assign the open chat to one assignee, and create, edit or
// delete assignees (name + colour) the same way labels work. Without a chat it only manages them.
// Without `canManage` assignees can be used but not changed.
export function AssignDropdown({
  conversation,
  assignees,
  canManage,
  onAssigned,
  onAssigneeSaved,
  onAssigneeDeleted,
}: {
  conversation?: Conversation;
  assignees: Assignee[];
  canManage: boolean;
  onAssigned: (conversationId: string, assignee: Conversation['assignee']) => void;
  onAssigneeSaved: (assignee: Assignee) => void;
  onAssigneeDeleted: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{
    id: string | null;
    name: string;
    color: string;
  } | null>(null);
  const [colorValid, setColorValid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  function close() {
    setOpen(false);
    setEditing(null);
    setError('');
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

  // Switching chats closes the menu
  useEffect(close, [conversation?.id]);

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

  // Like a label checkbox: tick to assign, untick the ticked one to unassign. The menu stays open.
  function toggle(assigneeId: string) {
    if (!conversation) return;
    attempt(async () => {
      const c = await assignConversation(conversation.id, conversation.assignee?.id === assigneeId ? null : assigneeId);
      onAssigned(c.id, c.assignee);
    });
  }

  const nextColor = LABEL_COLORS[assignees.length % LABEL_COLORS.length];
  const term = query.trim();
  const visible = assignees.filter((a) => a.name.toLowerCase().includes(term.toLowerCase()));
  const exactMatch = assignees.some((a) => a.name.toLowerCase() === term.toLowerCase());

  // New assignees open the form first so the name and colour can be previewed before saving
  function startNew(name: string) {
    setError('');
    setEditing({ id: null, name, color: nextColor });
  }

  function save() {
    if (!editing || !colorValid) return;
    attempt(async () => {
      const input = { name: editing.name.trim(), color: editing.color };
      const saved = editing.id ? await updateAssignee(editing.id, input) : await createAssignee(input);
      onAssigneeSaved(saved);
      // One created from a chat is assigned to it straight away
      if (!editing.id && conversation) {
        const c = await assignConversation(conversation.id, saved.id);
        onAssigned(c.id, c.assignee);
      }
      setEditing(null);
      setQuery('');
    });
  }

  function remove(a: { id: string; name: string }) {
    if (!confirm(`Delete "${a.name}"? Chats assigned to them will become unassigned.`)) return;
    attempt(async () => {
      await deleteAssignee(a.id);
      onAssigneeDeleted(a.id);
      setEditing(null);
    });
  }

  const current = conversation?.assignee;

  return (
    <div ref={ref} className="relative">
      <button
        data-assign-dropdown
        onClick={() => (open ? close() : setOpen(true))}
        title={conversation ? 'Assign this chat' : 'Manage assignees'}
        className={`flex items-center gap-1.5 rounded-full border bg-surface py-1 pl-1.5 pr-2.5 text-xs hover:bg-surface-muted transition cursor-pointer ${open ? 'border-primary text-primary' : 'border-line text-muted'}`}
      >
        {current ? (
          <AssigneeAvatar assignee={current} />
        ) : (
          <span className="flex h-5 w-5 items-center justify-center text-faint">
            <PersonIcon className="h-4 w-4" />
          </span>
        )}
        <span className="max-w-[90px] truncate font-medium">{current ? current.name : 'Assign'}</span>
        <svg className="h-3 w-3 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Assign chat"
          className="absolute right-0 top-11 flex max-h-[70vh] w-64 max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-2xl border border-line bg-surface text-xs shadow-xl z-50"
        >
          <div className="flex items-center justify-between border-b border-line-soft px-3 py-2">
            <span className="font-semibold text-ink">
              {editing
                ? editing.id
                  ? 'Edit assignee'
                  : 'New assignee'
                : conversation
                  ? 'Assign chat'
                  : canManage
                    ? 'Manage assignees'
                    : 'Assignees'}
            </span>
            <button onClick={close} title="Close" className="text-faint hover:text-body-soft">
              ✕
            </button>
          </div>

          {error && <div className="mx-3 mt-2 rounded-lg bg-danger-soft px-2.5 py-1.5 text-danger">{error}</div>}

          {editing ? (
            <form
              className="space-y-3 p-3"
              onSubmit={(e) => {
                e.preventDefault();
                save();
              }}
            >
              <input
                autoFocus
                value={editing.name}
                maxLength={50}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="Name"
                className={inputClass}
              />
              <ColorField
                color={editing.color}
                onChange={(color) => setEditing({ ...editing, color })}
                onValidChange={setColorValid}
                preview={(color) => {
                  const name = editing.name.trim() || 'Name';
                  return (
                    <span className="flex items-center gap-1.5 text-xs font-medium text-body">
                      <AssigneeAvatar assignee={{ id: 'preview', name, color }} />
                      <span className="truncate">{name}</span>
                    </span>
                  );
                }}
              />
              <div className="flex items-center justify-between gap-2">
                {editing.id ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => remove({ id: editing.id!, name: editing.name })}
                    className="rounded-lg px-2 py-1.5 font-medium text-danger hover:bg-danger-soft disabled:opacity-50"
                  >
                    Delete
                  </button>
                ) : (
                  <span />
                )}
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    className="rounded-lg px-2.5 py-1.5 font-medium text-body-soft hover:bg-surface-strong"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={busy || !editing.name.trim() || !colorValid}
                    className="rounded-lg bg-primary px-3 py-1.5 font-semibold text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Save
                  </button>
                </div>
              </div>
            </form>
          ) : (
            <>
              <div className="p-2">
                <input
                  autoFocus
                  value={query}
                  maxLength={50}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && term && !exactMatch && canManage) startNew(term);
                  }}
                  placeholder={canManage ? 'Search or add a name' : 'Search names'}
                  className={inputClass}
                />
              </div>
              <ul className="min-h-0 flex-1 overflow-y-auto pb-1">
                {visible.map((a) => (
                  <li key={a.id} className="flex items-center gap-1 px-1">
                    <button
                      disabled={busy || !conversation}
                      onClick={() => toggle(a.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-muted disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      {conversation && <Checkbox on={current?.id === a.id} color={a.color} />}
                      <AssigneeAvatar assignee={a} />
                      <span className="truncate text-body">{a.name}</span>
                      <span className="ml-auto text-[10px] text-faint">{a.conversationCount}</span>
                    </button>
                    {canManage && (
                      <button
                        title={`Edit ${a.name}`}
                        onClick={() => {
                          setError('');
                          setEditing({
                            id: a.id,
                            name: a.name,
                            color: a.color,
                          });
                        }}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-surface-strong hover:text-body"
                      >
                        <svg
                          className="h-3 w-3"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                        </svg>
                      </button>
                    )}
                  </li>
                ))}
                {assignees.length === 0 && !term && (
                  <li className="px-3 py-2 text-muted">
                    {canManage ? 'No assignees yet. Type a name to add one.' : 'No assignees yet.'}
                  </li>
                )}
                {visible.length === 0 && term && !canManage && (
                  <li className="px-3 py-2 text-muted">No names match.</li>
                )}
              </ul>
              {canManage && (
                <div className="border-t border-line-soft p-1">
                  {term && !exactMatch ? (
                    <button
                      disabled={busy}
                      onClick={() => startNew(term)}
                      className="w-full truncate rounded-lg px-2 py-1.5 text-left font-medium text-primary hover:bg-primary-subtle disabled:opacity-50"
                    >
                      + Add &ldquo;{term}&rdquo;
                    </button>
                  ) : (
                    <button
                      onClick={() => startNew(term)}
                      className="w-full rounded-lg px-2 py-1.5 text-left font-medium text-primary hover:bg-primary-subtle"
                    >
                      + New assignee
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Same checkbox as the label picker. Only one can be ticked: picking another moves the tick.
function Checkbox({ on, color }: { on: boolean; color?: string }) {
  return (
    <span
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-bold ${on ? `border-transparent text-on-primary ${color ? '' : 'bg-primary'}` : 'border-line-strong'}`}
      style={on && color ? { backgroundColor: color } : undefined}
    >
      {on && '✓'}
    </span>
  );
}
