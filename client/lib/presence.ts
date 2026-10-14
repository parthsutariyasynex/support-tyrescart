import { useSyncExternalStore } from 'react';
import type { Socket } from 'socket.io-client';

// Live presence (online / away / offline) of workspace members, fed by whichever page socket is open. The server
// decides the status from its connections and activity pings; this store only mirrors it for the UI.
export type PresenceStatus = 'online' | 'away' | 'offline';
export type PresenceEntry = { userId: string; status: PresenceStatus; lastActiveAt: string | null };

export const PRESENCE_STYLES: Record<PresenceStatus, { label: string; color: string }> = {
  online: { label: 'Online', color: '#16a34a' },
  away: { label: 'Away', color: '#eab308' },
  offline: { label: 'Offline', color: '#dc2626' },
};

// Anyone not reported by the server is offline
export const presenceOf = (map: Record<string, PresenceEntry>, userId: string | null | undefined): PresenceStatus =>
  (userId && map[userId]?.status) || 'offline';

export function applyPresence(map: Record<string, PresenceEntry>, update: PresenceEntry): Record<string, PresenceEntry> {
  const current = map[update.userId];
  if (current && current.status === update.status && current.lastActiveAt === update.lastActiveAt) return map;
  return { ...map, [update.userId]: update };
}

let state: Record<string, PresenceEntry> = {};
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function usePresence() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

// Send "I'm active" at most every ACTIVITY_PING_MS while the person uses the page
const ACTIVITY_PING_MS = 30_000;
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'focus'] as const;

// Attach to a page's socket: mirrors presence:update, loads the current list, and reports this tab's activity.
// Returns a cleanup; the caller disconnects the socket itself.
export function bindPresence(socket: Socket) {
  const onUpdate = (u: PresenceEntry) => {
    const next = applyPresence(state, u);
    if (next !== state) {
      state = next;
      emit();
    }
  };
  const load = () =>
    socket.emit('presence:list', (list: PresenceEntry[]) => {
      state = Object.fromEntries(list.map((e) => [e.userId, e]));
      emit();
    });
  socket.on('presence:update', onUpdate);
  socket.on('connect', load);
  if (socket.connected) load();

  let last = 0;
  const ping = () => {
    const now = Date.now();
    if (now - last < ACTIVITY_PING_MS) return;
    last = now;
    socket.emit('presence:activity');
  };
  const onVisible = () => {
    if (!document.hidden) ping();
  };
  for (const e of ACTIVITY_EVENTS) document.addEventListener(e, ping, { passive: true });
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    socket.off('presence:update', onUpdate);
    socket.off('connect', load);
    for (const e of ACTIVITY_EVENTS) document.removeEventListener(e, ping);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
