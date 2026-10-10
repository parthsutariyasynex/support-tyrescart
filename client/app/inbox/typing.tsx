'use client';

import { useCallback, useEffect, useRef } from 'react';

// How long a "typing" signal lasts without a refresh, and how often we refresh it while typing
export const TYPING_TTL_MS = 6000;
const RESEND_MS = 2500;
const IDLE_MS = 3000;

// conversationId -> userId -> { name, until }
export type TypingState = Record<string, Record<string, { name: string; until: number }>>;
export type TypingEvent = { conversationId: string; userId: string; name: string; typing: boolean };

export function applyTypingEvent(state: TypingState, e: TypingEvent): TypingState {
  const current = { ...(state[e.conversationId] ?? {}) };
  if (e.typing) current[e.userId] = { name: e.name, until: Date.now() + TYPING_TTL_MS };
  else delete current[e.userId];
  return { ...state, [e.conversationId]: current };
}

// Drop signals that weren't refreshed (closed tab, lost connection); returns the same object if nothing expired
export function pruneTyping(state: TypingState): TypingState {
  const now = Date.now();
  let changed = false;
  const next: TypingState = {};
  for (const [conversationId, typers] of Object.entries(state)) {
    const alive = Object.fromEntries(Object.entries(typers).filter(([, t]) => t.until > now));
    if (Object.keys(alive).length !== Object.keys(typers).length) changed = true;
    if (Object.keys(alive).length) next[conversationId] = alive;
  }
  return changed ? next : state;
}

export const typingNames = (state: TypingState, conversationId: string) =>
  Object.values(state[conversationId] ?? {}).map((t) => t.name);

export function typingLabel(names: string[]) {
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return `${names.length} people are typing`;
}

export function TypingDots() {
  return (
    <span className="ml-0.5 inline-flex gap-0.5 align-middle" aria-hidden="true">
      {[0, 150, 300].map((delay) => (
        <span key={delay} className="h-1 w-1 animate-bounce rounded-full bg-current" style={{ animationDelay: `${delay}ms` }} />
      ))}
    </span>
  );
}

// Sends "typing" at most every RESEND_MS while the agent types, and "stopped" after IDLE_MS of no input,
// on send, or when the chat closes
export function useTypingSender(send: (typing: boolean) => void) {
  const typing = useRef(false);
  const lastSent = useRef(0);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendRef = useRef(send);
  sendRef.current = send;

  const stop = useCallback(() => {
    if (idle.current) clearTimeout(idle.current);
    idle.current = null;
    if (typing.current) sendRef.current(false);
    typing.current = false;
  }, []);

  const onInput = useCallback(
    (value: string) => {
      if (!value.trim()) return stop();
      const now = Date.now();
      if (!typing.current || now - lastSent.current > RESEND_MS) {
        sendRef.current(true);
        lastSent.current = now;
        typing.current = true;
      }
      if (idle.current) clearTimeout(idle.current);
      idle.current = setTimeout(stop, IDLE_MS);
    },
    [stop],
  );

  useEffect(() => stop, [stop]); // leaving the chat
  return { onInput, stop };
}
