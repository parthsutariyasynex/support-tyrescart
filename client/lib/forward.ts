import { sendTextMessage, type Conversation, type Message } from './inbox';
import { DOCUMENT_TYPES, IMAGE_TYPES, isMediaPlaceholder, mediaUrl, sendFile } from './media';
import { lastCustomerMessageAt, windowOpen } from './messagingWindow';
import { sendVoice } from './voice';

// Forwarding a message to other chats, like WhatsApp: the same text, or the same file (with its name and caption),
// sent from the chosen chat with the usual sending (and its rules: the 24-hour window, closed chats, who may write).
// Only what this app can send can be forwarded: text, JPEG/PNG photos, documents and voice notes.

export const FORWARD_MAX = 5; // chats at once, as in WhatsApp
export type ForwardKind = 'text' | 'image' | 'document' | 'voice';
const baseMime = (mime: string | null | undefined) => (mime ?? '').split(';')[0].trim().toLowerCase();

export function forwardKind(m: Pick<Message, 'type' | 'body' | 'mediaMime' | 'deletedAt'>): ForwardKind | null {
  if (m.deletedAt) return null;
  const mime = baseMime(m.mediaMime);
  if (m.type === 'image') return IMAGE_TYPES.includes(mime) ? 'image' : null;
  if (m.type === 'document') return DOCUMENT_TYPES[mime] ? 'document' : null;
  if (m.type === 'voice') return /^audio\/(ogg|webm|mp4)$/.test(mime) ? 'voice' : null;
  if (['video', 'audio', 'sticker'].includes(m.type)) return null; // not something this app sends
  const text = m.body?.trim() ?? '';
  return text && !isMediaPlaceholder(text) && !text.startsWith('[template]') ? 'text' : null;
}

// Why a chat can't take a forwarded message right now ('' = it can): the same rules the message box follows
export function forwardBlocked(c: Pick<Conversation, 'status' | 'lastInboundAt'>, now = Date.now()) {
  if (c.status === 'closed') return 'Closed: reopen it to write';
  if (!windowOpen(lastCustomerMessageAt(c.lastInboundAt), now)) return '24-hour window closed: only templates can be sent';
  return '';
}

// Sends one message to one chat; returns the new message (it also arrives live, like any message you send)
export async function forwardMessage(m: Message, conversationId: string): Promise<Message> {
  const kind = forwardKind(m);
  if (!kind) throw new Error("This message can't be forwarded");
  if (kind === 'text') return sendTextMessage(conversationId, m.body);
  const blob = await (await fetch(await mediaUrl(m.id))).blob();
  const mime = baseMime(m.mediaMime);
  if (kind === 'voice') return sendVoice(conversationId, new Blob([blob], { type: mime }));
  const ext = kind === 'image' ? (mime === 'image/png' ? 'png' : 'jpg') : DOCUMENT_TYPES[mime];
  const name = m.mediaName || `${kind === 'image' ? 'photo' : 'document'}.${ext}`;
  const caption = m.body && !isMediaPlaceholder(m.body) ? m.body : '';
  return sendFile(conversationId, new File([blob], name, { type: mime }), caption);
}
