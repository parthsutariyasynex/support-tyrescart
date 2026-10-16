import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { downloadMedia } from '../whatsapp.js';
import { withSender } from './senders.js';

// Media customers send (photos, videos, voice notes, audio, documents, stickers): downloaded from WhatsApp right
// after the message is saved, then kept like the files your team sends (UPLOADS_DIR/<workspace>/<message>.<ext>).
// If a download fails it's tried again the next time someone opens the file.

export const INCOMING_MAX_BYTES = 100 * 1024 * 1024; // WhatsApp's largest media (documents)
const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/3gpp': '3gp',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/aac': 'aac', 'audio/amr': 'amr', 'audio/mp4': 'm4a',
  'application/pdf': 'pdf', 'text/plain': 'txt',
  'application/msword': 'doc', 'application/vnd.ms-excel': 'xls', 'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

// A plain "type/subtype" (WhatsApp sends e.g. "audio/ogg; codecs=opus"); anything odd becomes a generic binary type
export function cleanMime(raw: unknown) {
  const base = String(raw ?? '').toLowerCase().split(';')[0].trim();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(base) && base.length <= 100 ? base : 'application/octet-stream';
}

// A customer's document name, safe to show and to download under
export function cleanIncomingName(raw: unknown) {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\\/\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return name || null;
}

// Saves the file for a message and tells everyone with the chat open (message:updated), so it appears live
export async function storeIncomingMedia(workspaceId: string, messageId: string, bytes: Buffer, mime: string) {
  const type = cleanMime(mime);
  const relative = path.join(workspaceId, `${messageId}.${EXT[type] ?? 'bin'}`);
  await mkdir(path.join(env.uploadsDir, workspaceId), { recursive: true });
  await writeFile(path.join(env.uploadsDir, relative), bytes);
  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { mediaPath: relative, mediaMime: type, mediaSize: bytes.length, version: { increment: 1 } },
  });
  emitToWorkspace(workspaceId, 'message:updated', await withSender(updated));
}

// Downloads a message's media from WhatsApp if it isn't stored yet. True when the file is there afterwards.
// One download per message at a time (the background download and someone opening the file share it).
const inFlight = new Map<string, Promise<boolean>>();
export function fetchIncomingMedia(workspaceId: string, messageId: string, fetchImpl?: typeof fetch) {
  let p = inFlight.get(messageId);
  if (!p) {
    p = (async () => {
      const message = await prisma.message.findFirst({ where: { id: messageId, conversation: { workspaceId } }, select: { waMediaId: true, mediaPath: true } });
      if (!message) return false;
      if (message.mediaPath) return true;
      if (!message.waMediaId) return false;
      const account = await prisma.whatsAppAccount.findUnique({ where: { workspaceId } });
      if (!account) return false;
      const { bytes, mime } = await downloadMedia(account, message.waMediaId, INCOMING_MAX_BYTES, fetchImpl);
      await storeIncomingMedia(workspaceId, messageId, bytes, mime);
      return true;
    })().finally(() => inFlight.delete(messageId));
    inFlight.set(messageId, p);
  }
  return p;
}
