'use client';

import { useEffect, useId, useRef, useState } from 'react';

export type AssignAction = 'assign' | 'reassign' | 'unassign';

const inputClass =
  'w-full rounded-lg border border-line bg-surface-muted/70 px-3 py-2 text-xs text-ink-soft placeholder:text-faint outline-hidden focus:border-primary focus:bg-surface focus:ring-1 focus:ring-primary';

// Popup shown after picking a person in the Assign box. The Assignment Reason is compulsory for assigning and
// reassigning (the server refuses it without one) and optional for unassigning. The reason is stored for the
// admin assignment report only; it is never shown in the chat, its history or the timeline.
export function AssignReasonDialog({
  action,
  person,
  previous,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  action: AssignAction;
  // The person being assigned (assign/reassign) or released (unassign)
  person: string;
  // Who holds the chat now (reassign only)
  previous?: string | null;
  busy: boolean;
  error: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const titleId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const required = action !== 'unassign';
  const ready = !required || reason.trim().length > 0;

  useEffect(() => {
    textareaRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onCancel();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const title = action === 'assign' ? `Assign to ${person}` : action === 'reassign' ? `Reassign to ${person}` : `Unassign ${person}`;
  const body =
    action === 'assign'
      ? `${person} will get this chat and see it in their My Chats.`
      : action === 'reassign'
        ? `The chat moves from ${previous ?? 'the current assignee'} to ${person}.`
        : `${person} will no longer hold this chat. It goes back to New Leads until someone takes it or assigns it.`;
  const confirmLabel = action === 'assign' ? 'Assign' : action === 'reassign' ? 'Reassign' : 'Yes, unassign';

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-shadow/40 p-4 sm:items-center" onClick={() => !busy && onCancel()}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !busy) onConfirm(reason);
        }}
        className="w-full max-w-sm rounded-2xl bg-surface p-5 text-ink-soft shadow-xl"
      >
        <h2 id={titleId} className="text-sm font-bold text-ink">
          {title}
        </h2>
        <p className="mt-1.5 text-xs leading-relaxed text-muted">{body}</p>
        <label className="mt-4 block text-[11px] font-semibold text-body">
          Assignment reason{required ? <span className="text-danger"> *</span> : <span className="font-normal text-faint"> (optional)</span>}
          <textarea
            ref={textareaRef}
            value={reason}
            maxLength={500}
            rows={3}
            required={required}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && ready && !busy) {
                e.preventDefault();
                onConfirm(reason);
              }
            }}
            placeholder={required ? 'Why is this chat being assigned to them?' : 'Why is this chat being released?'}
            className={`${inputClass} mt-1 resize-none`}
          />
        </label>
        <p className="mt-1 text-[10px] text-faint">Kept for the admin assignment report only. Not shown in the chat.</p>
        {error && <div className="mt-3 rounded-lg bg-danger-soft px-2.5 py-1.5 text-xs text-danger">{error}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onCancel} className="rounded-lg px-3 py-1.5 text-xs font-medium text-body-soft hover:bg-surface-strong disabled:opacity-50">
            {action === 'unassign' ? 'No' : 'Cancel'}
          </button>
          <button
            type="submit"
            disabled={busy || !ready}
            title={!ready ? 'Please give a reason' : undefined}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
