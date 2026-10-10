'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Conversation } from '@/lib/inbox';
import {
  type Label,
  LABEL_COLORS,
  addConversationLabel,
  createLabel,
  deleteLabel,
  removeConversationLabel,
  updateLabel,
} from '@/lib/labels';
import { ColorField } from './colors';

type LabelRef = Conversation['labels'][number];

// Label colours are user data, so they're applied inline rather than as theme tokens
export function LabelChips({ labels, max = labels.length }: { labels: LabelRef[]; max?: number }) {
  if (labels.length === 0) return null;
  const shown = labels.slice(0, max);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {shown.map((l) => (
        <span
          key={l.id}
          title={l.name}
          className="inline-flex max-w-28 items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium text-body"
          style={{ backgroundColor: `${l.color}24` }}
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: l.color }} />
          <span className="truncate">{l.name}</span>
        </span>
      ))}
      {labels.length > shown.length && (
        <span className="text-[10px] font-medium text-faint">+{labels.length - shown.length}</span>
      )}
    </div>
  );
}

export function TagIcon({ className = 'h-3.5 w-3.5' }: { className?: string }) {
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
      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
      <circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />
    </svg>
  );
}

const WIDTH = 256;
const GAP = 6;
const MARGIN = 8;

// Fixed-position popover so it isn't clipped by the scrolling conversation list
function usePosition(anchor: HTMLElement, panel: React.RefObject<HTMLDivElement | null>) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect();
    const height = panel.current?.offsetHeight ?? 320;
    const width = Math.min(WIDTH, window.innerWidth - MARGIN * 2);
    const left = Math.min(Math.max(MARGIN, a.right - width), window.innerWidth - width - MARGIN);
    const below = a.bottom + GAP;
    const top = below + height <= window.innerHeight - MARGIN ? below : Math.max(MARGIN, a.top - GAP - height);
    setPos({ top, left });
  }, [anchor, panel]);
  return pos;
}

// Assign/remove labels on a conversation, and create, edit or delete the workspace's labels.
// Without `conversation` it only manages labels. Without `canManage` labels can be used but not changed.
export function LabelPicker({
  anchor,
  conversation,
  labels,
  canManage,
  onClose,
  onLabelSaved,
  onLabelDeleted,
  onConversationLabels,
}: {
  anchor: HTMLElement;
  conversation?: Conversation;
  labels: Label[];
  canManage: boolean;
  onClose: () => void;
  onLabelSaved: (label: Label) => void;
  onLabelDeleted: (id: string) => void;
  onConversationLabels: (conversationId: string, labels: LabelRef[]) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const pos = usePosition(anchor, panelRef);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{
    id: string | null;
    name: string;
    color: string;
  } | null>(null);
  const [colorValid, setColorValid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    function onPointer(e: MouseEvent) {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !anchor.contains(t)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    // Close when whatever holds the anchor scrolls (it would leave the popover behind)
    function onScroll(e: Event) {
      const t = e.target;
      if (t === document || (t instanceof Node && t.contains(anchor))) onClose();
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

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

  const assigned = new Set(conversation?.labels.map((l) => l.id));
  const term = query.trim();
  const visible = labels.filter((l) => l.name.toLowerCase().includes(term.toLowerCase()));
  const exactMatch = labels.some((l) => l.name.toLowerCase() === term.toLowerCase());

  function toggle(label: Label) {
    if (!conversation) return;
    attempt(async () => {
      const c = assigned.has(label.id)
        ? await removeConversationLabel(conversation.id, label.id)
        : await addConversationLabel(conversation.id, label.id);
      onConversationLabels(c.id, c.labels);
    });
  }

  // New labels open the form first so the name and colour can be previewed before saving
  function startNew(name: string) {
    setError('');
    setEditing({
      id: null,
      name,
      color: LABEL_COLORS[labels.length % LABEL_COLORS.length],
    });
  }

  function save() {
    if (!editing || !colorValid) return;
    attempt(async () => {
      const input = { name: editing.name.trim(), color: editing.color };
      const saved = editing.id ? await updateLabel(editing.id, input) : await createLabel(input);
      onLabelSaved(saved);
      // A label created from a chat is applied to it straight away
      if (!editing.id && conversation) {
        const c = await addConversationLabel(conversation.id, saved.id);
        onConversationLabels(c.id, c.labels);
      }
      setEditing(null);
      setQuery('');
    });
  }

  function remove(label: { id: string; name: string }) {
    if (!confirm(`Delete label "${label.name}"? It will be removed from all chats.`)) return;
    attempt(async () => {
      await deleteLabel(label.id);
      onLabelDeleted(label.id);
      setEditing(null);
    });
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Labels"
      className="fixed z-50 flex max-h-[70vh] flex-col overflow-hidden rounded-xl border border-line bg-surface text-xs shadow-lg"
      style={{
        width: `min(${WIDTH}px, calc(100vw - ${MARGIN * 2}px))`,
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <div className="flex items-center justify-between border-b border-line-soft px-3 py-2">
        <span className="font-semibold text-ink">
          {editing
            ? editing.id
              ? 'Edit label'
              : 'New label'
            : conversation
              ? 'Label chat'
              : canManage
                ? 'Manage labels'
                : 'Labels'}
        </span>
        <button onClick={onClose} title="Close" className="text-faint hover:text-body-soft">
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
            placeholder="Label name"
            className="w-full rounded-lg border border-line bg-surface-muted/70 px-3 py-1.5 text-ink-soft placeholder:text-faint outline-hidden focus:border-primary focus:bg-surface focus:ring-1 focus:ring-primary"
          />
          <ColorField
            color={editing.color}
            onChange={(color) => setEditing({ ...editing, color })}
            onValidChange={setColorValid}
            preview={(color) => (
              <LabelChips
                labels={[
                  {
                    id: 'preview',
                    name: editing.name.trim() || 'Label name',
                    color,
                  },
                ]}
              />
            )}
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
              placeholder={canManage ? 'Search or create a label' : 'Search labels'}
              className="w-full rounded-lg border border-line bg-surface-muted/70 px-3 py-1.5 text-ink-soft placeholder:text-faint outline-hidden focus:border-primary focus:bg-surface focus:ring-1 focus:ring-primary"
            />
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto pb-1">
            {visible.map((l) => {
              const on = assigned.has(l.id);
              return (
                <li key={l.id} className="group flex items-center gap-1 px-1">
                  <button
                    disabled={busy || !conversation}
                    onClick={() => toggle(l)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-muted disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    {conversation && (
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-bold ${on ? 'border-transparent text-on-primary' : 'border-line-strong'}`}
                        style={on ? { backgroundColor: l.color } : undefined}
                      >
                        {on && '✓'}
                      </span>
                    )}
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: l.color }} />
                    <span className="truncate text-body">{l.name}</span>
                    <span className="ml-auto text-[10px] text-faint">{l.conversationCount}</span>
                  </button>
                  {canManage && (
                    <button
                      title={`Edit ${l.name}`}
                      onClick={() => {
                        setError('');
                        setEditing({ id: l.id, name: l.name, color: l.color });
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
              );
            })}
            {visible.length === 0 && !term && (
              <li className="px-3 py-2 text-muted">
                {canManage ? 'No labels yet. Type a name to create one.' : 'No labels yet.'}
              </li>
            )}
            {visible.length === 0 && term && !canManage && <li className="px-3 py-2 text-muted">No labels match.</li>}
          </ul>
          {canManage && (
            <div className="border-t border-line-soft p-1">
              {term && !exactMatch ? (
                <button
                  disabled={busy}
                  onClick={() => startNew(term)}
                  className="w-full truncate rounded-lg px-2 py-1.5 text-left font-medium text-primary hover:bg-primary-subtle disabled:opacity-50"
                >
                  + Create &ldquo;{term}&rdquo;
                </button>
              ) : (
                <button
                  onClick={() => startNew(term)}
                  className="w-full rounded-lg px-2 py-1.5 text-left font-medium text-primary hover:bg-primary-subtle"
                >
                  + New label
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
