import { useSyncExternalStore } from 'react';
import { type LiveLocation, fetchMyLiveLocations, stopLiveLocation, updateLiveLocation } from './location';
import { errorCode } from './api';

// Live locations as the app knows them (cards in the chat, the "you're sharing" bar), kept current by the server's
// live:changed events. For your own live locations, this tab follows your position (navigator.geolocation) and
// sends it, every ~10 seconds or sooner when you move, until the time is up or you stop. Sharing only continues
// while the app is open somewhere: the browser gives no position to a closed tab.

const lives = new Map<string, LiveLocation>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  listeners.forEach((l) => l());
};

export function setLive(live: LiveLocation) {
  lives.set(live.messageId, live);
  // Ended (or another tab stopped it): stop following the position here
  if (!isLiveNow(live)) stopWatching(live.messageId);
  changed();
}

export const isLiveNow = (l: Pick<LiveLocation, 'active' | 'stoppedAt' | 'until'>, now = Date.now()) => l.active && !l.stoppedAt && new Date(l.until).getTime() > now;

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// One live location (undefined: not known yet)
export function useLive(messageId: string) {
  return useSyncExternalStore(subscribe, () => lives.get(messageId), () => undefined);
}

// Your own live locations still running (for the "You're sharing your live location" bar)
export function useMyActiveLives(userId: string | null | undefined) {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return userId ? [...lives.values()].filter((l) => l.userId === userId && isLiveNow(l)) : [];
}

// --- Following your position while you share ---

const MIN_INTERVAL_MS = 10_000;
const MOVED_GAP_MS = 3000;
const MOVED_METRES = 25;
type Point = { lat: number; lng: number; accuracy: number | null };
type Watcher = {
  watchId: number;
  endTimer: ReturnType<typeof setTimeout>;
  lastSent: number;
  last: { lat: number; lng: number } | null;
  // The newest position not sent yet (too soon after the last one): sent as soon as allowed, so where you end up
  // always arrives even when the browser reports nothing more (you've stopped moving)
  pending: Point | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
};
const watchers = new Map<string, Watcher>();

// Distance in metres between two points (haversine)
export function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

// Whether a new position is worth sending: the first one, after the interval, or after moving noticeably
export function shouldSend(last: { lat: number; lng: number } | null, lastSent: number, next: { lat: number; lng: number }, now = Date.now()) {
  if (!last) return true;
  if (now - lastSent >= MIN_INTERVAL_MS) return true;
  return metresBetween(last, next) >= MOVED_METRES && now - lastSent >= MOVED_GAP_MS;
}

// When a held-back position may go: soon after a real move, otherwise at the regular interval
export function sendDelay(last: { lat: number; lng: number } | null, lastSent: number, next: { lat: number; lng: number }, now = Date.now()) {
  const gap = last && metresBetween(last, next) >= MOVED_METRES ? MOVED_GAP_MS : MIN_INTERVAL_MS;
  return Math.max(0, lastSent + gap - now);
}

export function startWatching(live: LiveLocation, onProblem?: (message: string) => void) {
  if (watchers.has(live.messageId) || !isLiveNow(live) || typeof navigator === 'undefined' || !navigator.geolocation) return;
  const w: Watcher = {
    watchId: 0,
    endTimer: setTimeout(() => stopWatching(live.messageId), Math.max(0, new Date(live.until).getTime() - Date.now())),
    lastSent: 0,
    last: null,
    pending: null,
    flushTimer: null,
  };
  if (live.position) {
    w.last = { lat: live.position.latitude, lng: live.position.longitude };
    w.lastSent = new Date(live.position.at).getTime();
  }
  const send = (p: Point) => {
    if (w.flushTimer) clearTimeout(w.flushTimer);
    w.flushTimer = null;
    w.pending = null;
    w.last = { lat: p.lat, lng: p.lng };
    w.lastSent = Date.now();
    updateLiveLocation(live.messageId, { latitude: p.lat, longitude: p.lng, accuracy: p.accuracy })
      .then(setLive)
      .catch((err) => {
        // Ended meanwhile (stopped elsewhere, or time up): stop following
        if (errorCode(err) === 'LIVE_ENDED' || errorCode(err) === 'NOT_FOUND') stopWatching(live.messageId);
      });
  };
  w.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const next: Point = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null };
      if (shouldSend(w.last, w.lastSent, next)) return send(next);
      w.pending = next;
      if (w.flushTimer) clearTimeout(w.flushTimer);
      w.flushTimer = setTimeout(() => w.pending && send(w.pending), sendDelay(w.last, w.lastSent, next));
    },
    (err) => {
      if (err.code === 1) {
        stopWatching(live.messageId);
        onProblem?.('Location access was turned off, so your live location stopped updating. Allow location for this site to continue.');
      }
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
  );
  watchers.set(live.messageId, w);
}

export function stopWatching(messageId: string) {
  const w = watchers.get(messageId);
  if (!w) return;
  navigator.geolocation?.clearWatch(w.watchId);
  clearTimeout(w.endTimer);
  if (w.flushTimer) clearTimeout(w.flushTimer);
  watchers.delete(messageId);
}

export async function stopSharing(messageId: string) {
  stopWatching(messageId);
  setLive(await stopLiveLocation(messageId));
}

// After a reload: your live locations still running carry on from this tab
export async function resumeMyLiveLocations(onProblem?: (message: string) => void) {
  const mine = await fetchMyLiveLocations().catch(() => [] as LiveLocation[]);
  for (const live of mine) {
    lives.set(live.messageId, live);
    startWatching(live, onProblem);
  }
  if (mine.length) changed();
}
