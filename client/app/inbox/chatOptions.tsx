'use client';

import { useEffect, useRef, useState } from 'react';

export type ChatOption = { label: string; onSelect: () => void; danger?: boolean; icon: React.ReactNode };

// Chat header "More options" (three-dot) menu
// `busy`: an option's request is in flight (shows a spinner instead of the dots)
export function ChatOptionsMenu({
  options,
  disabled,
  busy,
}: {
  options: ChatOption[];
  disabled?: boolean;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent | TouchEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-label="More options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`flex h-7 w-7 items-center justify-center rounded-full text-body-soft transition hover:bg-surface-strong hover:text-body disabled:opacity-50 ${open ? 'bg-surface-strong text-body' : ''}`}
      >
        {busy ? (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line-strong border-t-primary" />
        ) : (
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="5" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="12" cy="19" r="1.8" />
          </svg>
        )}
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Chat options"
          className="absolute right-0 top-9 z-50 w-48 rounded-xl border border-line bg-surface p-1 text-xs shadow-lg"
        >
          {options.map((o) => (
            <button
              key={o.label}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                o.onSelect();
              }}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left font-medium transition ${
                o.danger ? 'text-danger hover:bg-danger-soft' : 'text-body hover:bg-surface-muted'
              }`}
            >
              <svg
                className="h-4 w-4 shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {o.icon}
              </svg>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export const CloseIcon = (
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.5 12.5 2.5 2.5 4.5-5" />
  </>
);
export const ClearIcon = (
  <>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    <path d="m9.5 8.5 5 5" />
    <path d="m14.5 8.5-5 5" />
  </>
);

// Confirmation for "Clear chat"
export function ConfirmClearDialog({
  busy,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onCancel();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-shadow/40 p-4 sm:items-center"
      onClick={() => !busy && onCancel()}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="clear-chat-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl bg-surface p-5 text-ink-soft shadow-xl"
      >
        <h2 id="clear-chat-title" className="text-sm font-bold text-ink">
          Clear this chat?
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          All messages and history in this chat will be cleared from your view only. Your teammates and the customer
          still see everything, and new messages will show up as usual.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            disabled={busy}
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-body-soft hover:bg-surface-strong disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            disabled={busy}
            onClick={onConfirm}
            className="rounded-lg bg-danger px-3 py-1.5 text-xs font-semibold text-on-primary hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Clearing…' : 'Clear chat'}
          </button>
        </div>
      </div>
    </div>
  );
}
