import { filePreview, isMediaPlaceholder } from './media';

// Desktop notifications for new customer messages (shown by the app shell, on every page, while the app isn't the
// window you're looking at). One per new incoming message: the customer's name and a one-line preview; clicking it
// opens the chat. Our own messages, deleted ones and repeats (the same message arriving twice) get none.

export type MessageEvent = {
  conversation?: { contact?: { name?: string | null; waId?: string } | null } | null;
  message: { id: string; conversationId: string; direction: string; type: string; body: string; mediaName?: string | null; deletedAt?: string | null };
};
export type Notice = { title: string; body: string; tag: string; conversationId: string };

const PREVIEW_MAX = 120;
const REMEMBER = 200; // message ids kept to spot repeats

export function customerMessageNotice(e: MessageEvent, seen: Set<string>): Notice | null {
  const m = e?.message;
  if (!m || m.direction !== 'in' || m.deletedAt || seen.has(m.id)) return null;
  seen.add(m.id);
  if (seen.size > REMEMBER) seen.delete(seen.values().next().value!); // forget the oldest
  const contact = e.conversation?.contact;
  const title = contact?.name?.trim() || (contact?.waId ? `+${contact.waId}` : 'New message');
  // "📷 Photo", "🎤 Voice message", "📄 invoice.pdf"… for files; the text otherwise
  const text = (filePreview(m) ?? (m.body && !isMediaPlaceholder(m.body) ? m.body : '')).replace(/\s+/g, ' ').trim() || 'New message';
  return {
    title,
    body: text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text,
    tag: `message-${m.conversationId}`, // one per chat: a newer message replaces the older pop-up (and one across tabs)
    conversationId: m.conversationId,
  };
}

// Only while you aren't looking at the app: another tab, another window, or minimised
export const appInBackground = () => typeof document !== 'undefined' && (document.hidden || !document.hasFocus());
