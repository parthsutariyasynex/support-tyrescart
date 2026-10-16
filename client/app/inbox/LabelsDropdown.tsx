'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { Conversation } from '@/lib/inbox';
import { type Label, addConversationLabel, removeConversationLabel } from '@/lib/labels';
import { labelToastText, showToast } from '@/lib/toasts';

type LabelRef = Conversation['labels'][number];

// Label colours are user data, so the pill uses them inline: a light tint behind, the colour (darkened so light
// colours stay readable) for the text
export const labelPillStyle = (color: string) => ({ backgroundColor: `${color}24`, color: `color-mix(in srgb, ${color} 72%, #000)` });

export function LabelPill({ name, color }: { name: string; color: string }) {
  return (
    <span className="inline-flex max-w-full items-center truncate rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide" style={labelPillStyle(color)}>
      {name}
    </span>
  );
}

// Profile panel "Labels +": search, tick labels on/off for this chat, and "Manage labels" (opens Settings → Labels)
export function LabelsDropdown({
  conversation,
  labels,
  onConversationLabels,
  onClose,
}: {
  conversation: Conversation;
  labels: Label[];
  onConversationLabels: (conversationId: string, labels: LabelRef[]) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  // The box ticks (or unticks) at once; it goes back if saving fails
  const [pending, setPending] = useState<{ id: string; checked: boolean } | null>(null);
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onPointer = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      // the + button toggles the dropdown itself
      if (!ref.current?.contains(t) && !t.closest('[data-labels-toggle]')) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const on = new Set(conversation.labels.map((l) => l.id));
  const term = query.trim().toLowerCase();
  const shown = labels.filter((l) => !term || l.name.toLowerCase().includes(term));
  const contactName = conversation.contact.name || `+${conversation.contact.waId}`;

  async function toggle(label: Label) {
    if (busyId) return;
    const removing = on.has(label.id);
    setBusyId(label.id);
    setPending({ id: label.id, checked: !removing });
    setError('');
    try {
      const c = removing ? await removeConversationLabel(conversation.id, label.id) : await addConversationLabel(conversation.id, label.id);
      onConversationLabels(c.id, c.labels);
      const t = labelToastText(removing ? 'removed' : 'added', label.name, contactName);
      showToast(t.key, c.id, t.message, t.detail);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
      setPending(null);
    }
  }

  return (
    <div ref={ref} role="dialog" aria-label="Labels" className="absolute inset-x-3 top-full z-30 mt-1 flex max-h-[420px] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xl">
      <div className="p-3 pb-2">
        <div className="flex items-center gap-2 rounded-lg border border-primary px-3 py-2 ring-1 ring-primary">
          <svg className="h-4 w-4 shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search labels"
            className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
          />
        </div>
      </div>
      {error && <p className="mx-3 mb-2 rounded-lg bg-danger-soft px-2.5 py-1.5 text-xs text-danger">{error}</p>}
      <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
        {shown.map((l) => {
          const checked = pending?.id === l.id ? pending.checked : on.has(l.id);
          return (
            <li key={l.id}>
              <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-surface-muted">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(l)}
                  aria-label={l.name}
                  className="h-4 w-4 shrink-0 cursor-pointer rounded border-line-strong accent-primary"
                />
                <LabelPill name={l.name} color={l.color} />
              </label>
            </li>
          );
        })}
        {shown.length === 0 && <li className="px-3 py-4 text-center text-xs text-muted">{term ? `No label matches “${query.trim()}”` : 'No labels yet'}</li>}
      </ul>
      <div className="border-t border-line-soft p-1.5">
        <button
          type="button"
          onClick={() => {
            onClose();
            router.push('/settings/labels');
          }}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-body hover:bg-surface-muted"
        >
          <svg className="h-4 w-4 text-body-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h6v6" />
            <path d="M10 14 21 3" />
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          </svg>
          Manage labels
        </button>
      </div>
    </div>
  );
}
