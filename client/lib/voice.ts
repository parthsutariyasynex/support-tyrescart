import { API_URL, getToken } from './api';
import type { Message } from './inbox';

// Voice notes from the chat: recorded with the browser's microphone (MediaRecorder), sent like WhatsApp voice notes.
// The server turns Chrome/Edge's WebM into OGG/Opus (Firefox records OGG itself), which WhatsApp shows as a voice
// note; Safari records MP4, sent as an audio message.

export const VOICE_MAX_MS = 15 * 60 * 1000; // stops by itself after 15 minutes (well under WhatsApp's 16 MB)
export const VOICE_MIN_MS = 1000;

// Best format this browser can record, in WhatsApp's order of preference; null = can't record here
export function pickRecordingType(isSupported: (type: string) => boolean) {
  return ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/mp4'].find((t) => isSupported(t)) ?? null;
}

// 0:07, 1:05, 12:00
export function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// Why recording couldn't start, in plain words (from getUserMedia's error)
export function micErrorMessage(err: unknown) {
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError')
    return 'Microphone access is blocked. Allow the microphone for this site in your browser settings, then try again.';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'No microphone was found. Connect one and try again.';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'The microphone is being used by another app. Close it and try again.';
  if (name === 'NoRecorder') return "This browser can't record voice messages.";
  if (name === 'NoMediaDevices') return 'Recording needs a secure connection (https). Open the app over https and try again.';
  return "Couldn't start recording. Check your microphone and try again.";
}

export async function sendVoice(conversationId: string, recording: Blob, replyToId?: string | null): Promise<Message> {
  const res = await fetch(`${API_URL}/inbox/conversations/${encodeURIComponent(conversationId)}/voice${replyToId ? `?replyTo=${encodeURIComponent(replyToId)}` : ''}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken() ?? ''}`, 'Content-Type': recording.type || 'audio/webm' },
    body: recording,
  }).catch(() => {
    throw new Error("Couldn't reach the server. Check your connection and try again.");
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Couldn't send the voice message (${res.status})`);
  return data as Message;
}
