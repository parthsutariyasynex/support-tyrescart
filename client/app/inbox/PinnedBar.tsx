'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { type Message, fetchPinnedMessages } from '@/lib/inbox';
import { quotePreview } from '@/lib/media';
import { PIN_PATH } from './messages';

// A message pinned or unpinned for the team (from Socket.IO message:pinned, or this tab's own Pin / Unpin)
export const MESSAGE_PINNED_EVENT = 'app:message-pinned';

// WhatsApp-style bar under the chat header: the chat's pinned messages (for the whole team), newest pin first. It shows
// one at a time with "n of m"; a click jumps to that message (when it's loaded) and moves on to the next pin.
// Hidden when nothing is pinned; follows pins and unpins from anyone at once.
export function PinnedBar({ conversationId, onJump }: { conversationId: string; onJump: (messageId: string) => void }) {
  const [pins, setPins] = useState<Message[]>([]);
  const [index, setIndex] = useState(0);
  const current = useRef(conversationId);

  const load = useCallback(() => {
    const id = conversationId;
    fetchPinnedMessages(id)
      .then((list) => {
        if (current.current !== id) return;
        setPins(list);
        setIndex((i) => (i < list.length ? i : 0));
      })
      .catch(() => {}); // the chat works without the bar
  }, [conversationId]);

  useEffect(() => {
    current.current = conversationId;
    setPins([]);
    setIndex(0);
    load();
  }, [conversationId, load]);

  useEffect(() => {
    const on = (e: Event) => (e as CustomEvent<{ conversationId?: string }>).detail?.conversationId === conversationId && load();
    window.addEventListener(MESSAGE_PINNED_EVENT, on);
    return () => window.removeEventListener(MESSAGE_PINNED_EVENT, on);
  }, [conversationId, load]);

  if (!pins.length) return null;
  const pin = pins[Math.min(index, pins.length - 1)];
  const who = pin.direction === 'in' ? 'Customer' : (pin.senderName ?? 'Team');
  return (
    <button
      type="button"
      onClick={() => {
        onJump(pin.id);
        setIndex((i) => (i + 1) % pins.length);
      }}
      aria-label={`Pinned message ${index + 1} of ${pins.length}: go to it`}
      title="Go to the pinned message"
      className="flex w-full shrink-0 items-center gap-2.5 border-b border-line/90 bg-surface px-4 py-2 text-left text-xs hover:bg-surface-muted"
    >
      <svg className="h-4 w-4 shrink-0 text-body-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {PIN_PATH}
      </svg>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold text-ink">
          {who}
          {pins.length > 1 && <span className="ml-1.5 font-normal text-muted">· {Math.min(index, pins.length - 1) + 1} of {pins.length} pinned</span>}
        </span>
        <span className="block truncate text-body-soft">{quotePreview({ type: pin.type, body: pin.body, mediaName: pin.mediaName })}</span>
      </span>
    </button>
  );
}
