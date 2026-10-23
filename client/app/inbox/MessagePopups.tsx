'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { type MessagePopup, POPUP_SECONDS, dismissMessagePopup, useMessagePopups } from '@/lib/messagePopups';

function Popup({ popup, onOpen }: { popup: MessagePopup; onOpen: (conversationId: string) => void }) {
  useEffect(() => {
    const t = setTimeout(() => dismissMessagePopup(popup.id), POPUP_SECONDS * 1000);
    return () => clearTimeout(t);
  }, [popup.id]);
  return (
    <div className="message-popup pointer-events-auto flex w-80 max-w-full items-start gap-3 rounded-xl border border-line bg-surface px-3.5 py-3 text-xs shadow-2xl">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-bold text-primary" aria-hidden="true">
        {popup.title.replace(/^\+/, '').charAt(0).toUpperCase()}
      </span>
      <button
        type="button"
        onClick={() => {
          dismissMessagePopup(popup.id);
          onOpen(popup.conversationId);
        }}
        className="min-w-0 flex-1 text-left"
      >
        <span className="block truncate font-semibold text-ink">{popup.title}</span>
        <span className="mt-0.5 line-clamp-2 text-body-soft">{popup.body}</span>
      </button>
      <button type="button" onClick={() => dismissMessagePopup(popup.id)} title="Dismiss" aria-label="Dismiss" className="rounded-md px-1.5 py-0.5 text-faint hover:bg-surface-muted hover:text-ink">
        ✕
      </button>
    </div>
  );
}

// New customer messages while you're in the app, on every page: the customer's name and the message, sliding in
// at the top right; click to open the chat
export function MessagePopups({ onOpen }: { onOpen: (conversationId: string) => void }) {
  const popups = useMessagePopups();
  if (!popups.length || typeof document === 'undefined') return null;
  return createPortal(
    <div role="status" aria-live="polite" className="pointer-events-none fixed right-4 top-16 z-[60] flex max-w-[calc(100vw-32px)] flex-col items-end gap-2">
      {popups.map((p) => (
        <Popup key={p.id} popup={p} onOpen={onOpen} />
      ))}
    </div>,
    document.body,
  );
}
