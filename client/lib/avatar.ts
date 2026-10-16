import { API_URL, getToken } from './api';
import { ME_CHANGED_EVENT } from './auth';

// Your profile picture (Settings → General → Profile). The API keeps it (GET/PUT/DELETE /me/avatar, behind your
// sign-in); `me.user.avatarUpdatedAt` says whether there is one and when it last changed.
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Why a picked file can't be used, or '' (the server checks again, from the bytes)
export function avatarProblem(file: { type: string; size: number }) {
  if (!AVATAR_TYPES.includes(file.type)) return 'Use a JPG, PNG or WebP picture';
  if (file.size > AVATAR_MAX_BYTES) return 'Profile pictures can be up to 2 MB';
  if (!file.size) return 'That file is empty';
  return '';
}

const auth = () => ({ Authorization: `Bearer ${getToken() ?? ''}` });
const changed = () => typeof window !== 'undefined' && window.dispatchEvent(new Event(ME_CHANGED_EVENT));

export async function uploadMyAvatar(file: File) {
  const problem = avatarProblem(file);
  if (problem) throw new Error(problem);
  const res = await fetch(`${API_URL}/me/avatar`, { method: 'PUT', headers: { ...auth(), 'Content-Type': file.type }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Couldn't upload the picture (${res.status})`);
  changed();
}

export async function removeMyAvatar() {
  const res = await fetch(`${API_URL}/me/avatar`, { method: 'DELETE', headers: auth() });
  if (!res.ok) throw new Error(`Couldn't remove the picture (${res.status})`);
  changed();
}

// Fetched once per version (it needs the sign-in token) and shown from a local object URL
let cached: { version: string; url: Promise<string | null> } | null = null;
export function myAvatarUrl(version: string | null | undefined): Promise<string | null> {
  if (!version) return Promise.resolve(null);
  if (cached?.version !== version) {
    const url = fetch(`${API_URL}/me/avatar`, { headers: auth() })
      .then(async (r) => (r.ok ? URL.createObjectURL(await r.blob()) : null))
      .catch(() => null);
    cached = { version, url };
  }
  return cached.url;
}
