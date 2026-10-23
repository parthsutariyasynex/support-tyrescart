import { useSyncExternalStore } from 'react';

// App-wide toasts (assignment, new chat, reminders). One store for the whole app, so a toast shows on every page
// (Inbox, My Chats, Teams, Reports, Account, ...) and survives an in-app page change (e.g. Assign to Me jumping to
// My Chats). One toast at a time; the same toast arriving again within DEDUPE_MS (a second tab of yours, a
// reconnect, a repeated event) is shown once. Toast texts never contain customer message text, only names.

export type Toast = { id: string; conversationId: string; message: string; detail: string };

export const DEDUPE_MS = 5_000;

type State = { current: Toast | null; last: { key: string; at: number } | null };
let state: State = { current: null, last: null };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

// Pure: should a toast with this key be shown now, given the last one shown?
export function isDuplicateToast(last: State['last'], key: string, now: number, windowMs = DEDUPE_MS) {
  return !!last && last.key === key && now - last.at < windowMs;
}

export function showToast(key: string, conversationId: string, message: string, detail = '', now = Date.now()) {
  if (isDuplicateToast(state.last, key, now)) return false;
  state = { current: { id: `${key}:${now}`, conversationId, message, detail }, last: { key, at: now } };
  emit();
  return true;
}

export function clearToast() {
  if (!state.current) return;
  state = { ...state, current: null };
  emit();
}

export function resetToasts() {
  state = { current: null, last: null };
  emit();
}

export const currentToast = () => state.current;
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export function useToast() {
  return useSyncExternalStore(subscribe, currentToast, () => null);
}

// --- Texts (pure, so they're unit-tested)

export type AssignmentEvent = {
  conversationId: string;
  actorId: string | null;
  actorName: string | null;
  contactName: string;
  assignee: { id: string; userId?: string | null; name: string } | null;
  previous: string | null;
};

// assignment:you (sent only to the new assignee)
export const assignedToYouText = (e: AssignmentEvent) => ({
  key: `you:${e.conversationId}:${e.actorName ?? ''}`,
  message: 'This chat has been assigned to you and is waiting for your attention.',
  detail: `${e.contactName}${e.actorName ? ` · by ${e.actorName}` : ''}`,
});

// assignment:removed (sent only to the previous assignee)
export function removedFromYouText(e: AssignmentEvent) {
  const who = e.actorName ?? 'A teammate';
  const a = e.assignee;
  return {
    key: `removed:${e.conversationId}:${e.actorName ?? ''}:${a?.id ?? ''}`,
    message: !a ? `${who} unassigned you from this chat.` : e.actorId && a.userId === e.actorId ? `${who} took this chat from you.` : `${who} reassigned this chat to ${a.name}.`,
    detail: e.contactName,
  };
}

// assignment:changed (sent only to other owners/admins, never the person who did it)
export function assignmentChangedText(e: AssignmentEvent) {
  const who = e.actorName ?? 'A teammate';
  const a = e.assignee;
  const self = !!a && !!e.actorId && a.userId === e.actorId;
  const message = a
    ? self
      ? `${who} took this chat${e.previous ? ` from ${e.previous}` : ''}.`
      : e.previous
        ? `${who} reassigned this chat from ${e.previous} to ${a.name}.`
        : `${who} assigned this chat to ${a.name}.`
    : `${who} unassigned ${e.previous ?? 'the assignee'} from this chat.`;
  return { key: `changed:${e.conversationId}:${e.actorName ?? ''}:${a?.id ?? ''}:${e.previous ?? ''}`, message, detail: e.contactName };
}

// collaborator:you (sent only to the person added)
export const addedAsCollaboratorText = (e: { conversationId: string; actorName: string | null; contactName: string }) => ({
  key: `collab:${e.conversationId}:${e.actorName ?? ''}`,
  message: `${e.actorName ?? 'A teammate'} added you as a collaborator on this chat.`,
  detail: e.contactName,
});

// collaborator:removed (sent only to the person removed)
export const removedAsCollaboratorText = (e: { conversationId: string; actorName: string | null; contactName: string }) => ({
  key: `uncollab:${e.conversationId}:${e.actorName ?? ''}`,
  message: `${e.actorName ?? 'A teammate'} removed you as a collaborator from this chat.`,
  detail: e.contactName,
});

// Your own removal of a collaborator (only you see it)
export const collaboratorRemovedByYouText = (name: string, yourself: boolean, contactName = '') => ({
  key: `uncollab-own:${name}:${contactName}:${Date.now()}`,
  message: yourself ? 'You removed yourself as a collaborator from this chat.' : `${name} removed as a collaborator from this chat.`,
  detail: contactName,
});

// Your own pin / unpin (pins are personal, so only you see it)
export const pinText = (pinned: boolean, contactName = '') => ({
  key: `pin:${pinned}:${contactName}:${Date.now()}`,
  message: pinned ? 'Chat pinned to the top of your list.' : 'Chat unpinned.',
  detail: contactName,
});

// Your own label change (only you see it): added to / removed from a chat, or a label deleted everywhere
export function labelToastText(action: 'added' | 'removed' | 'deleted', labelName: string, contactName = '') {
  const message =
    action === 'added' ? `Label "${labelName}" added to this chat.` : action === 'removed' ? `Label "${labelName}" removed from this chat.` : `Label "${labelName}" deleted from all chats.`;
  return { key: `label:${action}:${labelName}:${contactName}:${Date.now()}`, message, detail: contactName };
}

// chat:new (every member): a customer started a new chat. Never the message text.
export const newChatText = (e: { conversationId: string; contactName: string }) => ({
  key: `new:${e.conversationId}`,
  message: 'New chat received. It is waiting in New Leads.',
  detail: e.contactName,
});

// mention:you (sent only to the teammate mentioned): someone @mentioned you in an internal note
export type MentionEvent = { conversationId: string; actorName: string | null; contactName: string; text: string };
export const mentionedYouText = (e: MentionEvent) => ({
  key: `mention:${e.conversationId}:${e.text}`,
  message: `${e.actorName ?? 'A teammate'} mentioned you in a note.`,
  detail: `${e.contactName} · ${e.text}`,
});

export type ReminderEvent = { at: string; chats: { conversationId: string; contactName: string; kind?: 'assigned' | 'unassigned' }[] };

// assignment:reminder (per person): chats assigned to you not opened/answered, and new chats nobody has taken
export function reminderText(e: ReminderEvent) {
  const mine = e.chats.filter((c) => c.kind !== 'unassigned').length;
  const waiting = e.chats.length - mine;
  const parts: string[] = [];
  if (mine) parts.push(mine === 1 ? '1 chat assigned to you still needs attention' : `${mine} chats assigned to you still need attention`);
  if (waiting) parts.push(waiting === 1 ? '1 new chat is still unassigned and unread' : `${waiting} new chats are still unassigned and unread`);
  return {
    key: `reminder:${e.at}:${e.chats.map((c) => c.conversationId).join(',')}`,
    message: `Reminder: ${parts.join('; ')}.`,
    detail: e.chats.map((c) => c.contactName).join(', '),
  };
}
