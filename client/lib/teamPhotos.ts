import { API_URL, getToken, gql } from './api';
import { ME_CHANGED_EVENT } from './auth';

// Teammates' profile pictures, shown wherever a team member appears in chats (message bubbles, Assign menu, @mentions,
// collaborators). Which people have one, and its version, comes from workspaceMembers.avatarUpdatedAt; a change
// arrives live as the socket event member:avatar (teamPhotoChanged). Pictures need the sign-in token, so each is
// fetched once per version from GET /avatars/:userId and shown from a local object URL. No picture: initials.

let versions: Map<string, string | null> | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

// The version of a person's picture (null: none, undefined: not known yet)
export const teamPhotoVersion = (userId: string) => versions?.get(userId);

export function loadTeamPhotos(force = false) {
  if (loading && !force) return loading;
  loading = gql<{ workspaceMembers: { id: string; avatarUpdatedAt: string | null }[] }>(`query TeamPhotos { workspaceMembers { id avatarUpdatedAt } }`)
    .then(({ workspaceMembers }) => {
      versions = new Map(workspaceMembers.map((m) => [m.id, m.avatarUpdatedAt]));
      notify();
    })
    .catch(() => {
      loading = null; // tried again by the next avatar shown
    });
  return loading;
}

// Someone added, changed or removed their picture (member:avatar, or your own upload)
export function teamPhotoChanged(userId: string, avatarUpdatedAt: string | null) {
  versions ??= new Map();
  versions.set(userId, avatarUpdatedAt);
  notify();
}

export function onTeamPhotos(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

const urls = new Map<string, Promise<string | null>>();
export function teamPhotoUrl(userId: string, version: string): Promise<string | null> {
  const key = `${userId}@${version}`;
  let url = urls.get(key);
  if (!url) {
    url = fetch(`${API_URL}/avatars/${encodeURIComponent(userId)}`, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
      .then(async (r) => (r.ok ? URL.createObjectURL(await r.blob()) : null))
      .catch(() => null);
    urls.set(key, url);
  }
  return url;
}

// Your own upload or removal in Settings: everyone's list is read again (the socket event covers other people)
if (typeof window !== 'undefined') window.addEventListener(ME_CHANGED_EVENT, () => void loadTeamPhotos(true));
