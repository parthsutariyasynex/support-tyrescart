'use client';

import { useEffect, useRef, useState } from 'react';
import { type Activity, type NotificationFeed, activityText } from '@/lib/activity';

const timeAgo = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
};

// --- Sound: a short two-tone ping made with Web Audio (no audio file). Browsers only allow sound after the
// user has interacted with the page once, so the audio context is unlocked on the first click/keypress.
let audio: AudioContext | null = null;
export function unlockSound() {
  if (typeof window === 'undefined') return;
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
  } catch {
    audio = null;
  }
}
export function playPing() {
  if (!audio || audio.state !== 'running') return;
  const now = audio.currentTime;
  for (const [i, freq] of [880, 1320].entries()) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + i * 0.12);
    gain.gain.exponentialRampToValueAtTime(0.15, now + i * 0.12 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.18);
    osc.connect(gain).connect(audio.destination);
    osc.start(now + i * 0.12);
    osc.stop(now + i * 0.12 + 0.2);
  }
}

// --- Desktop pop-up (only used while the tab is in the background)
export function showDesktopNotification(title: string, body: string, tag: string, onClick: () => void) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  } catch {
    // some browsers only allow notifications from a service worker; the sound and tab title still work
  }
}

type Permission = NotificationPermission | 'unsupported';
const currentPermission = (): Permission =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

// Header bell: recent activity by others + customer messages, with an unseen badge
export function NotificationBell({
  feed,
  meId,
  onOpen,
  onSelect,
}: {
  feed: NotificationFeed | null;
  meId: string | null;
  onOpen: () => void; // marks everything seen
  onSelect: (conversationId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [permission, setPermission] = useState<Permission>('unsupported');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setPermission(currentPermission()), []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const unseen = feed?.unseen ?? 0;

  function toggle() {
    unlockSound();
    if (!open && unseen > 0) onOpen();
    setOpen(!open);
  }

  async function enableDesktop() {
    if (typeof Notification === 'undefined') return;
    setPermission(await Notification.requestPermission());
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={unseen ? `Notifications, ${unseen} new` : 'Notifications'}
        title="Notifications"
        className={`relative flex h-7.5 w-7.5 items-center justify-center rounded-full border bg-surface transition hover:bg-surface-muted cursor-pointer ${open ? 'border-primary text-primary' : 'border-line text-muted'}`}
      >
        <svg
          className="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unseen > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold text-on-primary">
            {unseen > 99 ? '99+' : unseen}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-11 z-50 flex max-h-[70vh] w-80 max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-2xl border border-line bg-surface text-xs shadow-xl"
        >
          <div className="border-b border-line-soft px-4 py-2.5 font-semibold text-ink">Notifications</div>

          {permission === 'default' && (
            <button
              type="button"
              onClick={enableDesktop}
              className="mx-3 mt-2.5 rounded-lg border border-primary-soft-border bg-primary-subtle px-3 py-2 text-left font-medium text-primary hover:bg-primary-soft transition"
            >
              Turn on desktop notifications for new customer messages
            </button>
          )}
          {permission === 'denied' && (
            <p className="mx-3 mt-2.5 rounded-lg bg-surface-muted px-3 py-2 text-muted">
              Desktop notifications are blocked for this site in your browser settings.
            </p>
          )}

          <ul className="min-h-0 flex-1 overflow-y-auto py-1">
            {(feed?.items ?? []).map((a: Activity) => (
              <li key={a.id}>
                <button
                  type="button"
                  disabled={!a.conversationId}
                  onClick={() => {
                    if (!a.conversationId) return;
                    setOpen(false);
                    onSelect(a.conversationId);
                  }}
                  className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left hover:bg-surface-muted transition"
                >
                  <span
                    className={`mt-1 h-2 w-2 shrink-0 rounded-full ${a.type === 'message_received' ? 'bg-accent' : 'bg-line-strong'}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-body">{activityText(a, meId, 'bell')}</span>
                    <span className="mt-0.5 block text-[10px] text-faint">{timeAgo(a.createdAt)}</span>
                  </span>
                </button>
              </li>
            ))}
            {feed && feed.items.length === 0 && (
              <li className="px-4 py-6 text-center text-muted">No notifications yet.</li>
            )}
            {!feed && <li className="px-4 py-6 text-center text-muted">Loading…</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
