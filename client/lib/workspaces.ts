import { formatShortDate } from './time';

// Remember the last workspace each account used, so signing in opens it again (the server only honours it
// if the account still belongs to that workspace). Browser storage can be unavailable: then nothing happens.
const key = (email: string) => `lastWorkspace:${email.trim().toLowerCase()}`;

export function rememberWorkspace(email: string, workspaceId: string) {
  try {
    localStorage.setItem(key(email), workspaceId);
  } catch {
    // private mode or blocked storage
  }
}

export function lastWorkspace(email: string): string | null {
  try {
    return localStorage.getItem(key(email));
  } catch {
    return null;
  }
}

// Workspaces with the same name get "· created <date> · #<id end>" so they can be told apart in the switcher
export function workspaceDetails(workspaces: { id: string; name: string; createdAt?: string | null }[], now: number = Date.now()) {
  const counts = new Map<string, number>();
  for (const w of workspaces) counts.set(w.name.trim().toLowerCase(), (counts.get(w.name.trim().toLowerCase()) ?? 0) + 1);
  return new Map(
    workspaces.map((w) => [
      w.id,
      (counts.get(w.name.trim().toLowerCase()) ?? 0) > 1
        ? [w.createdAt ? `created ${formatShortDate(w.createdAt, now)}` : null, `#${w.id.slice(-4)}`].filter(Boolean).join(' · ')
        : null,
    ]),
  );
}
