import type { Server, Socket } from 'socket.io';
import { env } from './env.js';

// Live presence per workspace member, from the Socket.IO connections themselves (no database state):
//   online  - at least one tab/device is connected and was active in the last PRESENCE_AWAY_MINUTES (default 5)
//   away    - connected, but no activity (mouse, keyboard, touch, tab focus) on any tab for that long
//   offline - no connection for a few seconds (a short grace period hides reconnect flicker)
// Tabs send `presence:activity` (throttled) when the person does something. Everyone in the workspace receives
// `presence:update` on each change; `presence:list` (or the GraphQL `presence` query) returns the current state.

export type PresenceStatus = 'online' | 'away' | 'offline';
export type PresenceEntry = { userId: string; status: PresenceStatus; lastActiveAt: string | null };

type Person = { sockets: Set<string>; lastActiveAt: number; status: PresenceStatus; offlineTimer: NodeJS.Timeout | null };

const OFFLINE_GRACE_MS = 5_000;
const SWEEP_MS = 15_000;
const MAX_ACTIVITY_PER_MIN = 60;

const byWorkspace = new Map<string, Map<string, Person>>();
let io: Server | null = null;

const awayAfterMs = () => Math.max(1, env.presenceAwayMinutes) * 60_000;

function people(workspaceId: string) {
  let m = byWorkspace.get(workspaceId);
  if (!m) byWorkspace.set(workspaceId, (m = new Map()));
  return m;
}

function entry(userId: string, p: Person): PresenceEntry {
  return { userId, status: p.status, lastActiveAt: p.lastActiveAt ? new Date(p.lastActiveAt).toISOString() : null };
}

function setStatus(workspaceId: string, userId: string, p: Person, status: PresenceStatus) {
  if (p.status === status) return;
  p.status = status;
  io?.to(workspaceId).emit('presence:update', entry(userId, p));
}

// Current state of everyone known in the workspace (members who never connected since the server started are
// simply absent, i.e. offline)
export function listPresence(workspaceId: string): PresenceEntry[] {
  return [...(byWorkspace.get(workspaceId) ?? new Map<string, Person>()).entries()].map(([userId, p]) => entry(userId, p));
}

// Marks everyone idle for longer than `idleMs` (default: the configured away time) as away
export function sweepPresence(now = Date.now(), idleMs = awayAfterMs()) {
  let changed = 0;
  for (const [workspaceId, m] of byWorkspace)
    for (const [userId, p] of m)
      if (p.status === 'online' && now - p.lastActiveAt >= idleMs) {
        setStatus(workspaceId, userId, p, 'away');
        changed++;
      }
  return changed;
}

export function registerPresence(server: Server) {
  io = server;
  const timer = setInterval(() => sweepPresence(), SWEEP_MS);
  timer.unref();
  server.use((socket: Socket, next) => {
    attachPresence(socket);
    next();
  });
}

function attachPresence(socket: Socket) {
  const { userId, workspaceId } = socket.data as { userId: string; workspaceId: string };
  const m = people(workspaceId);
  const p = m.get(userId) ?? { sockets: new Set<string>(), lastActiveAt: 0, status: 'offline' as PresenceStatus, offlineTimer: null };
  m.set(userId, p);
  if (p.offlineTimer) {
    clearTimeout(p.offlineTimer); // reconnected within the grace period
    p.offlineTimer = null;
  }
  p.sockets.add(socket.id);
  p.lastActiveAt = Date.now(); // connecting counts as activity
  setStatus(workspaceId, userId, p, 'online');

  let windowStart = Date.now();
  let count = 0;
  socket.on('presence:activity', () => {
    if (Date.now() - windowStart > 60_000) {
      windowStart = Date.now();
      count = 0;
    }
    if (++count > MAX_ACTIVITY_PER_MIN) return;
    p.lastActiveAt = Date.now();
    if (p.sockets.size > 0) setStatus(workspaceId, userId, p, 'online');
  });

  socket.on('presence:list', (ack?: (list: PresenceEntry[]) => void) => {
    if (typeof ack === 'function') ack(listPresence(workspaceId));
  });

  socket.on('disconnect', () => {
    p.sockets.delete(socket.id);
    if (p.sockets.size > 0) return; // other tabs/devices still connected
    p.offlineTimer = setTimeout(() => {
      p.offlineTimer = null;
      if (p.sockets.size === 0) setStatus(workspaceId, userId, p, 'offline');
    }, OFFLINE_GRACE_MS);
    p.offlineTimer.unref();
  });
}

// Removed or deactivated members drop out at once (their sockets are closed by disconnectMember)
export function forgetPresence(workspaceId: string, userId: string) {
  const m = byWorkspace.get(workspaceId);
  const p = m?.get(userId);
  if (!m || !p) return;
  if (p.offlineTimer) clearTimeout(p.offlineTimer);
  m.delete(userId);
  io?.to(workspaceId).emit('presence:update', { userId, status: 'offline', lastActiveAt: null });
}
