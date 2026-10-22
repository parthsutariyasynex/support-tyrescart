'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FORWARD_MAX, forwardBlocked, forwardMessage } from '@/lib/forward';
import { type Conversation, type Message, fetchConversations } from '@/lib/inbox';
import { showToast } from '@/lib/toasts';
import { QuoteBlock } from './messages';

// Forward a message (Reply's neighbour in the message menu): search your chats, pick up to FORWARD_MAX, send. Each
// chat gets the same text or file; chats that can't take it right now (closed, 24-hour window over) are shown but
// can't be picked, and anything the server refuses is reported per chat.
export function ForwardDialog({ message, onClose }: { message: Message; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [chats, setChats] = useState<Conversation[] | null>(null);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<Conversation[]>([]);
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<Record<string, string>>({});
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => searchRef.current?.focus(), []);
  // Your chats, newest first; searching uses the same search as the chat list (name, number, message text…)
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      fetchConversations(null, { search: query.trim() || null })
        .then((page) => live && setChats(page.nodes))
        .catch((e) => live && setError((e as Error).message));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const name = (c: Conversation) => c.contact.name || `+${c.contact.waId}`;
  const toggle = (c: Conversation) =>
    setPicked((p) => (p.some((x) => x.id === c.id) ? p.filter((x) => x.id !== c.id) : p.length < FORWARD_MAX ? [...p, c] : p));

  async function send() {
    setBusy(true);
    setFailures({});
    const failed: Record<string, string> = {};
    for (const c of picked) {
      try {
        await forwardMessage(message, c.id);
      } catch (e) {
        failed[c.id] = (e as Error).message;
      }
    }
    setBusy(false);
    const done = picked.length - Object.keys(failed).length;
    if (done) showToast(`forward:${message.id}:${Date.now()}`, '', `Forwarded to ${done} chat${done === 1 ? '' : 's'}.`, done === 1 ? name(picked.find((c) => !failed[c.id])!) : '');
    if (!Object.keys(failed).length) return onClose();
    // keep only the ones that failed, with why
    setFailures(failed);
    setPicked((p) => p.filter((c) => failed[c.id]));
  }

  // Drawn on top of the page (a portal): the chat panel's layer would put the chat list over part of it
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/50 p-4" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Forward message" className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-bold text-ink">Forward message</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="rounded-lg px-2 py-1 text-lg text-body-soft hover:bg-surface-muted">
            ×
          </button>
        </div>
        <div className="space-y-3 border-b border-line px-5 py-3">
          <QuoteBlock
            quote={{
              id: message.id,
              direction: message.direction,
              type: message.type,
              body: message.body,
              senderName: message.senderName ?? (message.automation ? 'Auto-reply' : null),
              deleted: false,
              mediaMime: message.mediaMime,
              mediaName: message.mediaName,
            }}
          />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats by name or number"
            aria-label="Search chats"
            className="w-full rounded-lg border border-line bg-surface-muted px-3 py-2 text-[13px] text-ink outline-none placeholder:text-faint focus:border-primary focus:bg-surface"
          />
        </div>

        <ul className="min-h-40 flex-1 overflow-y-auto py-1" aria-label="Chats">
          {error && <li className="px-5 py-4 text-[13px] text-danger">{error}</li>}
          {!chats && !error && <li className="px-5 py-6 text-center text-[13px] text-muted">Loading chats…</li>}
          {chats?.length === 0 && <li className="px-5 py-6 text-center text-[13px] text-muted">No chats match “{query.trim()}”</li>}
          {chats?.map((c) => {
            const blocked = forwardBlocked(c);
            const on = picked.some((x) => x.id === c.id);
            const full = !on && picked.length >= FORWARD_MAX;
            return (
              <li key={c.id}>
                <label
                  className={`flex items-center gap-3 px-5 py-2.5 ${blocked || full ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-surface-muted'}`}
                  title={blocked || (full ? `Up to ${FORWARD_MAX} chats at once` : undefined)}
                >
                  <input type="checkbox" checked={on} disabled={!!blocked || full || busy} onChange={() => toggle(c)} className="h-4 w-4 accent-primary" />
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-[12px] font-bold text-primary" aria-hidden="true">
                    {name(c).replace('+', '').slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-ink">{name(c)}</span>
                    <span className={`block truncate text-[11px] ${failures[c.id] ? 'text-danger' : 'text-faint'}`}>
                      {failures[c.id] ? `Not sent: ${failures[c.id]}` : blocked || (c.contact.name ? `+${c.contact.waId}` : '')}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          <span className="truncate text-[12px] text-muted">
            {picked.length ? `To ${picked.map(name).join(', ')}` : `Choose up to ${FORWARD_MAX} chats`}
          </span>
          <button
            type="button"
            onClick={send}
            disabled={!picked.length || busy}
            className="shrink-0 rounded-lg bg-primary px-5 py-2 text-[13px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
          >
            {busy ? 'Forwarding…' : 'Forward'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
