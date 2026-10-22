import { API_URL, getToken } from './api';
import type { Message } from './inbox';
import { clockKey, dayKey } from './time';

// Sending images (JPEG/PNG up to 5 MB) and documents (PDF, Word, Excel, PowerPoint, text up to 100 MB) from the
// chat: WhatsApp's limits. The server checks every file again, from the file itself.
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const DOCUMENT_MAX_BYTES = 100 * 1024 * 1024;
export const IMAGE_TYPES = ['image/jpeg', 'image/png'];
export const CAPTION_MAX = 1024;
// type -> extension; also used to recognise a file by its extension when the browser doesn't report a type
export const DOCUMENT_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
};
// For the file chooser
export const ACCEPT = [...IMAGE_TYPES, ...Object.keys(DOCUMENT_TYPES), ...Object.values(DOCUMENT_TYPES).map((e) => `.${e}`)].join(',');

export type FileKind = 'image' | 'document';

// The file's type: what the browser says, or worked out from the extension (some systems report none for .docx etc.)
export function fileType(file: { name: string; type: string }) {
  if (file.type && (IMAGE_TYPES.includes(file.type) || DOCUMENT_TYPES[file.type])) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  return Object.entries(DOCUMENT_TYPES).find(([, e]) => e === ext)?.[0] ?? file.type;
}

// What a file can be sent as, or why it can't (checked before upload)
export function checkFile(file: { name: string; type: string; size: number }): { kind: FileKind; type: string } | { problem: string } {
  const type = fileType(file);
  const kind: FileKind | null = IMAGE_TYPES.includes(type) ? 'image' : DOCUMENT_TYPES[type] ? 'document' : null;
  if (!kind) return { problem: 'This file type can\'t be sent. Send a JPEG or PNG image, or a PDF, Word, Excel, PowerPoint or text file.' };
  if (file.size === 0) return { problem: 'That file is empty.' };
  const max = kind === 'image' ? IMAGE_MAX_BYTES : DOCUMENT_MAX_BYTES;
  if (file.size > max) return { problem: `That ${kind} is ${formatSize(file.size)}. ${kind === 'image' ? 'Images can be up to 5 MB' : 'Documents can be up to 100 MB'}.` };
  return { kind, type };
}
// Kept for images-only callers
export function imageProblem(file: { name?: string; type: string; size: number }) {
  const r = checkFile({ name: file.name ?? '', ...file });
  if ('problem' in r) return r.problem.startsWith('This file type') ? 'Only JPEG and PNG images can be sent.' : r.problem;
  return r.kind === 'image' ? null : 'Only JPEG and PNG images can be sent.';
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// "PDF", "DOCX"…: shown on a document card
export function documentLabel(mime: string | null | undefined, name?: string | null) {
  return (DOCUMENT_TYPES[mime ?? ''] ?? name?.split('.').pop() ?? 'file').toUpperCase();
}

export async function sendFile(conversationId: string, file: File, caption: string, replyToId?: string | null): Promise<Message> {
  const r = checkFile(file);
  if ('problem' in r) throw new Error(r.problem);
  const q = new URLSearchParams();
  if (caption.trim()) q.set('caption', caption.trim());
  if (r.kind === 'document') q.set('name', file.name);
  if (replyToId) q.set('replyTo', replyToId);
  const route = r.kind === 'image' ? 'images' : 'documents';
  const res = await fetch(`${API_URL}/inbox/conversations/${encodeURIComponent(conversationId)}/${route}${q.size ? `?${q}` : ''}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken() ?? ''}`, 'Content-Type': r.type },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Couldn't send the file (${res.status})`);
  return data as Message;
}
export const sendImage = (conversationId: string, file: File, caption: string) => sendFile(conversationId, file, caption);

// A stored copy needs the sign-in token, so it's fetched once and used from a local object URL
const urls = new Map<string, Promise<string>>();
export function mediaUrl(messageId: string) {
  let p = urls.get(messageId);
  if (!p) {
    p = fetch(`${API_URL}/inbox/messages/${encodeURIComponent(messageId)}/media`, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } }).then(async (r) => {
      if (!r.ok) throw new Error(r.status === 404 ? 'File not available' : `Couldn't load the file (${r.status})`);
      return URL.createObjectURL(await r.blob());
    });
    p.catch(() => urls.delete(messageId)); // try again next time
    urls.set(messageId, p);
  }
  return p;
}
export const imageUrl = mediaUrl;

// Saves a document under its own name
export async function downloadFile(messageId: string, name: string) {
  const url = await mediaUrl(messageId);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// "[image]", "[video]"…: the text WhatsApp media arrives with when there's no caption (not shown under the file)
export const isMediaPlaceholder = (body: string) => /^\[(image|video|audio|document|sticker)\]$/.test(body.trim());

// Chat list preview for a file message: "📷 caption" / "📷 Photo", "🎥 Video", "🎤 Voice message"…
export function filePreview(m: { type: string; body: string; mediaName?: string | null }) {
  const text = m.body && !isMediaPlaceholder(m.body) ? m.body : '';
  switch (m.type) {
    case 'image':
      return `📷 ${text || 'Photo'}`;
    case 'sticker':
      return '🙂 Sticker';
    case 'video':
      return `🎥 ${text || 'Video'}`;
    case 'voice':
      return '🎤 Voice message';
    case 'audio':
      return '🎵 Audio';
    case 'document':
      return `📄 ${m.mediaName || text || 'Document'}`;
    default:
      return null;
  }
}

// The one line a quoted message shows (in a reply, and above the composer while replying)
export function quotePreview(q: { type: string; body: string; deleted?: boolean; mediaName?: string | null }) {
  if (q.deleted) return 'This message was deleted';
  return filePreview(q) ?? q.body;
}

// A pasted screenshot comes as "image.png" (or with no name): give it a readable one, like the system's own
// screenshots ("Screenshot 2026-10-21 at 14.30.05.png"). A copied file keeps its name.
export function pastedName(file: File, now = new Date()) {
  if (file.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(file.name)) return file;
  const ext = (file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
  const stamp = `${dayKey(now)} at ${clockKey(now).replaceAll(':', '.')}`; // Dubai time
  return new File([file], `Screenshot ${stamp}.${ext}`, { type: file.type, lastModified: file.lastModified });
}
