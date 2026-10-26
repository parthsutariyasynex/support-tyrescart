'use client';

import { useEffect, useId, useRef } from 'react';

// Yes / No confirmation shown inside the page (same look as the Clear chat dialog), used instead of the browser's
// confirm() popup. Esc or clicking outside = No. Shared by the Teams page (activate/deactivate, remove), the
// Assign box (unassign) and Delete chat (with Cancel / Delete as the buttons).
export function ConfirmDialog({
  title,
  body,
  yes,
  no = 'No',
  error,
  danger,
  busy,
  onYes,
  onNo,
}: {
  title: string;
  body: string;
  yes: string;
  no?: string;
  error?: string; // why the last try failed (shown above the buttons)
  danger: boolean;
  busy: boolean;
  onYes: () => void;
  onNo: () => void;
}) {
  const noRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    noRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onNo();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onNo]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-shadow/40 p-4 sm:items-center" onClick={() => !busy && onNo()}>
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-2xl bg-surface p-5 text-ink-soft shadow-xl">
        <h2 id={titleId} className="text-sm font-bold text-ink">
          {title}
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-muted">{body}</p>
        {error && (
          <p role="alert" className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button ref={noRef} type="button" disabled={busy} onClick={onNo} className="rounded-lg px-3 py-1.5 text-xs font-medium text-body-soft hover:bg-surface-strong disabled:opacity-50">
            {no}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onYes}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold text-on-primary disabled:opacity-50 ${danger ? 'bg-danger hover:opacity-90' : 'bg-primary hover:bg-primary-hover'}`}
          >
            {busy ? 'Working…' : yes}
          </button>
        </div>
      </div>
    </div>
  );
}
