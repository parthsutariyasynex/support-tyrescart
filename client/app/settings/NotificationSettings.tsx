'use client';

import { useEffect, useState } from 'react';
import { buttonClass } from '../AuthShell';
import { playPing, showDesktopNotification, unlockSound } from '../inbox/notifications';

// Settings → General → System preference: this browser's desktop pop-ups (allowed / blocked / not asked yet) and the
// sound. The bell and in-app toasts always work; pop-ups and the sound reach you while the tab is in the background.
type Permission = NotificationPermission | 'unsupported';
export function NotificationSettings() {
  const [permission, setPermission] = useState<Permission | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => setPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission), []);

  async function enable() {
    if (typeof Notification === 'undefined') return;
    setPermission(await Notification.requestPermission());
  }
  function test() {
    unlockSound();
    playPing();
    showDesktopNotification('Test notification', 'Desktop notifications are working.', 'settings-test', () => {});
    setMessage(permission === 'granted' ? 'Sent a test notification and played the sound.' : 'Played the sound. Allow desktop notifications to see pop-ups.');
  }

  const status: Record<Permission, { text: string; tone: string }> = {
    granted: { text: 'Allowed', tone: 'bg-primary-subtle text-primary' },
    denied: { text: 'Blocked', tone: 'bg-danger-soft text-danger' },
    default: { text: 'Not turned on', tone: 'bg-surface-strong text-body-soft' },
    unsupported: { text: 'Not supported by this browser', tone: 'bg-surface-strong text-body-soft' },
  };
  return (
    <div className="mt-6 w-full max-w-3xl">
      <p className="text-xs text-muted">The bell and in-app messages always work. Desktop pop-ups and the sound reach you while this tab is in the background.</p>
      <section className="mt-6 rounded-2xl border border-line bg-surface p-6 shadow-xs">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-bold text-ink">Desktop notifications</h2>
            <p className="mt-1 text-xs text-muted">New messages, chats assigned to you, and reminders, in this browser.</p>
          </div>
          {permission && (
            <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${status[permission].tone}`} aria-label="Desktop notifications status">
              {status[permission].text}
            </span>
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {permission === 'default' && (
            <button type="button" onClick={enable} className={`${buttonClass} !w-auto px-5`}>
              Turn on desktop notifications
            </button>
          )}
          <button type="button" onClick={test} className="rounded-lg border border-line px-4 py-2 text-xs font-semibold text-body hover:bg-surface-muted">
            Send a test
          </button>
        </div>
        {permission === 'denied' && <p className="mt-3 text-xs text-muted">They're blocked for this site. Allow notifications in your browser's site settings, then reload this page.</p>}
        {message && <p className="mt-3 text-xs text-body">{message}</p>}
      </section>
    </div>
  );
}
