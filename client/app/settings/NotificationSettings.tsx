'use client';

import { useEffect, useState } from 'react';
import { playPing, showDesktopNotification, unlockSound } from '../inbox/notifications';
import { setSoundEnabled, soundEnabled } from '@/lib/messagePopups';

// Settings → General → System preference: this browser's desktop notifications (allowed / blocked / not asked yet),
// the sound, and what the app always shows. Desktop notifications and the sound reach you while you aren't looking
// at the app (another tab or window, or minimised); the bell and in-app messages always work.
type Permission = NotificationPermission | 'unsupported';
const readPermission = (): Permission => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

const STATUS: Record<Permission, { text: string; tone: string }> = {
  granted: { text: 'On', tone: 'bg-primary-subtle text-primary' },
  denied: { text: 'Blocked', tone: 'bg-danger-soft text-danger' },
  default: { text: 'Off', tone: 'bg-surface-strong text-body-soft' },
  unsupported: { text: 'Not supported', tone: 'bg-surface-strong text-body-soft' },
};
const TRIGGERS = [
  { title: 'New customer messages', text: "The customer's name and the message. Click it to open the chat." },
  { title: 'Chats assigned to you', text: 'Who assigned it, and the customer.' },
  { title: 'Reminders', text: "Chats you haven't opened or answered yet." },
];

const primary = 'rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50';
const secondary = 'rounded-lg border border-line px-4 py-2 text-[13px] font-semibold text-body hover:bg-surface-muted disabled:opacity-50';
const card = 'rounded-xl border border-line bg-surface p-6';

export function NotificationSettings() {
  const [permission, setPermission] = useState<Permission | null>(null);
  const [message, setMessage] = useState('');
  const [sound, setSound] = useState(true);
  useEffect(() => setSound(soundEnabled()), []);

  // The status follows the browser: allowing or blocking in its site settings shows here without a reload
  useEffect(() => {
    setPermission(readPermission());
    let status: PermissionStatus | null = null;
    const update = () => setPermission(readPermission());
    navigator.permissions
      ?.query({ name: 'notifications' })
      .then((s) => {
        status = s;
        s.addEventListener('change', update);
      })
      .catch(() => {});
    window.addEventListener('focus', update);
    return () => {
      status?.removeEventListener('change', update);
      window.removeEventListener('focus', update);
    };
  }, []);

  async function enable() {
    if (typeof Notification === 'undefined') return;
    unlockSound();
    const result = await Notification.requestPermission();
    setPermission(result);
    setMessage(result === 'granted' ? 'Desktop notifications are on in this browser.' : result === 'denied' ? 'The browser blocked them. See below to allow them.' : '');
  }
  function test() {
    unlockSound();
    playPing();
    showDesktopNotification('Test notification', 'Desktop notifications are working.', 'settings-test', () => {});
    setMessage(permission === 'granted' ? 'Sent a test notification and played the sound.' : 'Played the sound. Turn on desktop notifications to see pop-ups.');
  }

  return (
    <div className="mt-4 space-y-5">
      <section className={card} aria-labelledby="desktop-title">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h4 id="desktop-title" className="text-[15px] font-bold text-ink">
              Desktop notifications
            </h4>
            <p className="mt-1 text-[13px] text-body-soft">Pop-ups from this browser while you aren&apos;t looking at the app: another tab or window, or minimised. Only for chats you may work on: yours, ones you collaborate on, and unassigned ones (owners and admins: all).</p>
          </div>
          {permission && (
            <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${STATUS[permission].tone}`} aria-label="Desktop notifications status">
              {STATUS[permission].text}
            </span>
          )}
        </div>

        <ul className="mt-4 divide-y divide-line-soft rounded-lg border border-line-soft">
          {TRIGGERS.map((t) => (
            <li key={t.title} className="flex items-start gap-3 px-4 py-3">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${permission === 'granted' ? 'bg-success' : 'bg-faint'}`} aria-hidden="true" />
              <span>
                <span className="block text-[13px] font-semibold text-ink">{t.title}</span>
                <span className="block text-[12px] text-body-soft">{t.text}</span>
              </span>
            </li>
          ))}
        </ul>

        {permission === 'denied' && (
          <div className="mt-4 rounded-lg bg-danger-soft px-4 py-3 text-[12px] text-danger" role="status">
            <p className="font-semibold">Blocked for this site in your browser.</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-body">
              <li>Click the icon to the left of the address bar (the lock or settings icon).</li>
              <li>
                Set <strong>Notifications</strong> to <strong>Allow</strong>.
              </li>
              <li>Come back to this page: it updates on its own (or reload it).</li>
            </ol>
          </div>
        )}
        {permission === 'unsupported' && (
          <p className="mt-4 rounded-lg bg-surface-muted px-4 py-3 text-[12px] text-body-soft">This browser can&apos;t show desktop notifications. The bell and in-app messages still work.</p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {permission === 'default' && (
            <button type="button" onClick={enable} className={primary}>
              Turn on desktop notifications
            </button>
          )}
          {permission === 'denied' && (
            <button type="button" onClick={() => window.location.reload()} className={secondary}>
              Reload page
            </button>
          )}
          <button type="button" onClick={test} disabled={permission === 'unsupported'} className={permission === 'granted' ? primary : secondary}>
            Send a test notification
          </button>
        </div>
        {message && (
          <p className="mt-3 text-[12px] text-body" role="status">
            {message}
          </p>
        )}
      </section>

      <section className={card} aria-labelledby="sound-title">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h4 id="sound-title" className="text-[15px] font-bold text-ink">
              Sound
            </h4>
            <p className="mt-1 text-[13px] text-body-soft">
              A short sound plays with each new message and notification, in the app or in the background. Browsers allow it after your first click on the page. Saved
              for this browser.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              onClick={() => {
                unlockSound();
                playPing();
              }}
              className={secondary}
            >
              Play sound
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={sound}
              aria-label="Notification sound"
              onClick={() => {
                setSoundEnabled(!sound);
                setSound(!sound);
              }}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors ${sound ? 'bg-success' : 'bg-faint/50'}`}
            >
              <span style={{ backgroundColor: '#fff', boxShadow: '0 1px 3px rgb(0 0 0 / 0.3)' }} className={`inline-block h-5 w-5 rounded-full transition-transform ${sound ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>
        </div>
      </section>

      <section className={card} aria-labelledby="inapp-title">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h4 id="inapp-title" className="text-[15px] font-bold text-ink">
              In the app
            </h4>
            <p className="mt-1 text-[13px] text-body-soft">
              The 🔔 bell keeps your recent activity. New customer messages slide in at the top right (name and message; click to open the chat), and messages appear at the bottom of the screen for chats assigned to you, new chats and reminders. These are
              always on.
            </p>
          </div>
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${STATUS.granted.tone}`}>Always on</span>
        </div>
      </section>
    </div>
  );
}
