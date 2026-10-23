import { useSyncExternalStore } from 'react';
import type { Notice } from './desktopNotifications';

// In-app pop-ups for new customer messages (slide in at the top right on every page while you're looking at the
// app; desktop notifications cover the time you aren't). One per chat: a newer message from the same chat replaces
// its pop-up and moves it to the top. At most POPUP_MAX at once, each closing on its own after POPUP_SECONDS.

export type MessagePopup = Notice & { id: string };

export const POPUP_MAX = 3;
export const POPUP_SECONDS = 6;

// Pure: the list after a new pop-up arrives (newest first)
export const addPopup = (list: MessagePopup[], popup: MessagePopup, max = POPUP_MAX) =>
  [popup, ...list.filter((p) => p.conversationId !== popup.conversationId)].slice(0, max);

let popups: MessagePopup[] = [];
const listeners = new Set<() => void>();
const set = (next: MessagePopup[]) => {
  popups = next;
  listeners.forEach((l) => l());
};

export const showMessagePopup = (n: Notice, now = Date.now()) => set(addPopup(popups, { ...n, id: `${n.conversationId}:${now}` }));
export const dismissMessagePopup = (id: string) => set(popups.filter((p) => p.id !== id));
// A chat was opened: its pop-up has been seen
export const dismissChatPopups = (conversationId: string) => {
  if (popups.some((p) => p.conversationId === conversationId)) set(popups.filter((p) => p.conversationId !== conversationId));
};
export const clearMessagePopups = () => set([]);

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const EMPTY: MessagePopup[] = [];
export const useMessagePopups = () => useSyncExternalStore(subscribe, () => popups, () => EMPTY);

// --- Sound preference (Settings → Notifications), this browser; on unless turned off
const SOUND_KEY = 'support:notificationSound';
export function soundEnabled() {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}
export function setSoundEnabled(on: boolean) {
  try {
    localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
  } catch {
    // storage unavailable (private mode): stays on for this visit
  }
}

// Whether you get alerts for a customer message in this chat, following who may work on it: owners and admins for
// every chat; everyone else for unassigned chats (anyone may pick them up), chats assigned to them, and chats they
// collaborate on (the same people the bell shows a chat's activity to)
export function alertsYou(c: { assigneeUserId: string | null; isCollaborator: boolean; unassigned: boolean }, me: { userId: string; isAdmin: boolean }) {
  return me.isAdmin || c.unassigned || c.assigneeUserId === me.userId || c.isCollaborator;
}
