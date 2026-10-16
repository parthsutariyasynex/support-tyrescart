'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CountryCode } from 'libphonenumber-js';
import { setToken } from '@/lib/api';
import { removeMyAvatar, uploadMyAvatar } from '@/lib/avatar';
import { changeMyPassword, joinName, requestPasswordReset, splitName, updateMyProfile } from '@/lib/auth';
import { passwordsProblem } from '@/lib/password';
import { presenceOf, usePresence } from '@/lib/presence';
import { currentZoneName, filterTimeZones, joinPhone, phoneCountries, splitPhone, timeZoneLabel, timeZoneOptions } from '@/lib/profileOptions';
import { defaultTimeZone } from '@/lib/time';
import { showToast } from '@/lib/toasts';
import { AppShell, type Me } from '../AppShell';
import { FormMessage, buttonClass, inputClass } from '../AuthShell';
import { PresenceDot } from '../PresenceDot';
import { SearchSelect } from '../SearchSelect';
import { UserAvatar } from '../UserAvatar';
import { NotificationSettings } from './NotificationSettings';
import { SettingsShell } from './SettingsShell';

// Settings → Your preferences → General (the header's gear icon). Profile: your picture, name, phone number (with
// its country), username, job title and unique link, your password, two-factor sign-in and your time zone (System
// preference). The System preference tab: desktop notifications and sound in this browser.
// ?tab=password scrolls to the password; ?tab=system opens System preference.
export default function SettingsPage() {
  return (
    <AppShell>
      {(me) => (
        <SettingsShell me={me} section="Your preferences" title="General">
          <General me={me} />
        </SettingsShell>
      )}
    </AppShell>
  );
}

const ROLE_NAMES: Record<string, string> = { owner: 'Owner', admin: 'Admin', supervisor: 'Supervisor', agent: 'Agent' };

type Tab = 'profile' | 'system';
function General({ me }: { me: Me }) {
  const [tab, setTab] = useState<Tab>('profile');
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t === 'system') setTab('system');
    if (t === 'password') setTimeout(() => document.getElementById('password')?.scrollIntoView({ block: 'start' }), 300);
  }, []);
  return (
    <div className="w-full max-w-3xl">
      <div role="tablist" aria-label="General" className="flex gap-1 border-b border-line">
        {(['profile', 'system'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-4 py-3 text-[13px] font-semibold transition ${tab === t ? 'border-primary text-primary' : 'border-transparent text-body-soft hover:text-body'}`}
          >
            {t === 'profile' ? 'Profile' : 'System preference'}
          </button>
        ))}
      </div>
      {tab === 'profile' ? (
        <Profile me={me} />
      ) : (
        <div className="mt-8">
          <h3 className="text-lg font-bold text-ink">Notifications</h3>
          <NotificationSettings />
        </div>
      )}
    </div>
  );
}

const readOnlyClass = 'w-full cursor-not-allowed rounded-lg bg-surface-strong px-3 py-2.5 text-[13px] text-muted';
// Field label; `hint` adds an ⓘ with an explanation on hover
const label = (text: string, htmlFor?: string, hint?: string) => (
  <label htmlFor={htmlFor} className="mb-1.5 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
    {text}
    {hint && (
      <span title={hint} aria-label={hint} className="inline-flex cursor-help normal-case text-faint">
        <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4M12 8h.01" />
        </svg>
      </span>
    )}
  </label>
);

function Profile({ me }: { me: Me }) {
  const presence = usePresence();
  const country0 = (me.workspace.settings?.defaultCountry ?? 'AE') as CountryCode; // the workspace's default
  const savedPhone = splitPhone(me.user.phone, country0);
  const saved = { ...splitName(me.user.name), country: savedPhone.country, phone: savedPhone.national, jobTitle: me.user.jobTitle ?? '' };
  const [first, setFirst] = useState(saved.first);
  const [last, setLast] = useState(saved.last);
  const [country, setCountry] = useState<CountryCode>(saved.country);
  const [phone, setPhone] = useState(saved.phone);
  const [jobTitle, setJobTitle] = useState(saved.jobTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const s = splitName(me.user.name);
    setFirst(s.first);
    setLast(s.last);
    const p = splitPhone(me.user.phone, country0);
    setCountry(p.country);
    setPhone(p.national);
    setJobTitle(me.user.jobTitle ?? '');
  }, [me.user.name, me.user.phone, me.user.jobTitle]);
  const name = joinName(first, last);
  const fullPhone = joinPhone(country, phone);
  const changed = name !== me.user.name.trim() || fullPhone !== (me.user.phone ?? '') || jobTitle.trim() !== saved.jobTitle;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!first.trim()) return setError('First name is required');
    setBusy(true);
    setError('');
    try {
      await updateMyProfile({ name, phone: fullPhone, jobTitle: jobTitle.trim() });
      showToast(`profile:${Date.now()}`, '', 'Profile saved.', name);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // The workspace's WhatsApp chat link (from the connected number); none until WhatsApp is connected
  const waDigits = (me.workspace.whatsapp?.displayPhone ?? '').replace(/\D/g, '');
  const uniqueLink = waDigits ? `https://wa.me/${waDigits}` : '';
  return (
    <>
      <div className="mt-8 flex items-center gap-5">
        <AvatarPicker me={me} presence={presenceOf(presence, me.user.id)} />
        <div className="min-w-0">
          <p className="truncate text-[15px] font-bold text-ink">{me.user.name}</p>
          <p className="text-[13px] text-muted">{ROLE_NAMES[me.role ?? ''] ?? me.role ?? ''}</p>
        </div>
      </div>

      <form onSubmit={save} className="mt-6">
        <h3 className="text-lg font-bold text-ink">Personal info</h3>
        <div className="mt-4 grid gap-x-4 gap-y-5 sm:grid-cols-2">
          <div>
            {label('First name', 'first-name')}
            <input id="first-name" value={first} onChange={(e) => setFirst(e.target.value)} maxLength={100} autoComplete="given-name" className={inputClass} />
          </div>
          <div>
            {label('Last name', 'last-name')}
            <input id="last-name" value={last} onChange={(e) => setLast(e.target.value)} maxLength={90} autoComplete="family-name" className={inputClass} />
          </div>
          <div className="sm:col-span-2">
            {label('Email')}
            <p className={readOnlyClass} title="Your sign-in email can't be changed here">
              {me.user.email}
            </p>
          </div>
          <div className="sm:col-span-2">
            {label('Phone number', 'phone')}
            <div className="flex gap-2">
              <CountryPicker value={country} onChange={setCountry} />
              <input
                id="phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                maxLength={20}
                inputMode="tel"
                autoComplete="tel-national"
                placeholder="50 123 4567"
                className={inputClass}
              />
            </div>
          </div>
          <div className="sm:col-span-2">
            {label('Username', undefined, "You sign in with your email, so it is your username. It can't be changed here.")}
            <p className={readOnlyClass}>{me.user.email}</p>
          </div>
          <div className="sm:col-span-2">
            {label('Job title', 'job-title', 'Your role in the team, e.g. Support lead')}
            <input id="job-title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} maxLength={100} autoComplete="organization-title" className={inputClass} />
          </div>
          <div className="sm:col-span-2">
            {label('Unique link', undefined, 'A link customers open to start a WhatsApp chat with this workspace')}
            <div className="flex gap-2">
              <p className={`${readOnlyClass} truncate`}>{uniqueLink || 'Connect WhatsApp to get a chat link'}</p>
              {uniqueLink && (
                <button
                  type="button"
                  onClick={() =>
                    navigator.clipboard
                      .writeText(uniqueLink)
                      .then(() => showToast(`link:${Date.now()}`, '', 'Link copied.', 'Unique link'))
                      .catch(() => setError("Couldn't copy the link"))
                  }
                  className={`${outlineButton} shrink-0`}
                >
                  Copy
                </button>
              )}
            </div>
          </div>
        </div>
        {error && <div className="mt-4"><FormMessage>{error}</FormMessage></div>}
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={!changed || busy}
            onClick={() => {
              setFirst(saved.first);
              setLast(saved.last);
              setCountry(saved.country);
              setPhone(saved.phone);
              setJobTitle(saved.jobTitle);
              setError('');
            }}
            className="rounded-lg px-3 py-2 text-xs text-body-soft hover:bg-surface-muted disabled:opacity-40"
          >
            Discard
          </button>
          <button type="submit" disabled={!changed || busy} className={`${buttonClass} !w-auto px-5 disabled:opacity-50`}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>

      <PasswordSection email={me.user.email} />
      <TwoFactorSection />
      <TimeZoneSection value={me.user.timeZone ?? null} />
    </>
  );
}

// Your picture (or initial) with an upload button on it; JPG, PNG or WebP up to 2 MB (the server checks the file).
// Shown in the top bar too.
function AvatarPicker({ me, presence }: { me: Me; presence: Parameters<typeof PresenceDot>[0]['status'] }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<void>, done: string) {
    setBusy(true);
    try {
      await action();
      showToast(`avatar:${Date.now()}`, '', done, 'Profile picture');
    } catch (err) {
      showToast(`avatar:${Date.now()}`, '', (err as Error).message, 'Profile picture');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex shrink-0 flex-col items-center gap-1.5">
      <UserAvatar me={me} className={`h-20 w-20 text-3xl ${busy ? 'opacity-60' : ''}`}>
        <span className="absolute bottom-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-surface">
          <PresenceDot status={presence} size="h-2.5 w-2.5" />
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => input.current?.click()}
          aria-label="Upload a profile picture"
          title="Upload a profile picture (JPG, PNG or WebP, up to 2 MB)"
          className="absolute -right-1 -top-1 flex h-7 w-7 items-center justify-center rounded-full border border-line bg-surface text-body shadow-sm transition hover:bg-surface-muted disabled:opacity-60"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />
          </svg>
        </button>
      </UserAvatar>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        aria-label="Profile picture file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) run(() => uploadMyAvatar(file), 'Profile picture updated.');
        }}
      />
      {me.user.avatarUpdatedAt && (
        <button type="button" disabled={busy} onClick={() => run(removeMyAvatar, 'Profile picture removed.')} className="text-[11px] text-body-soft hover:text-danger disabled:opacity-60">
          Remove
        </button>
      )}
    </div>
  );
}

// The country's flag and dial code (e.g. 🇦🇪 +971); a native list underneath, so it's searchable by typing
function CountryPicker({ value, onChange }: { value: CountryCode; onChange: (c: CountryCode) => void }) {
  const countries = phoneCountries();
  const current = countries.find((c) => c.code === value);
  return (
    <div className="relative shrink-0">
      <div className="pointer-events-none flex h-full items-center gap-1.5 rounded-xl border border-line bg-input px-3 text-sm text-ink" aria-hidden="true">
        <span className="text-base leading-none">{current?.flag}</span>
        <span>+{current?.dial}</span>
        <svg className="h-3.5 w-3.5 text-body-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as CountryCode)}
        aria-label="Country code"
        title={current ? `${current.name} (+${current.dial})` : 'Country code'}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      >
        {countries.map((c) => (
          <option key={c.code} value={c.code}>
            {c.flag} {c.name} (+{c.dial})
          </option>
        ))}
      </select>
    </div>
  );
}

const sectionClass = 'mt-14 scroll-mt-4';
const outlineButton =
  'rounded-lg border border-primary px-4 py-2 text-[13px] font-semibold text-primary transition hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50';

// A reset link to your email (as on the sign-in page), or change it here with your current password
function PasswordSection({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [changeHere, setChangeHere] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tab') === 'password') setChangeHere(true);
  }, []);

  async function sendLink() {
    setBusy(true);
    setError('');
    try {
      await requestPasswordReset(email);
      setSent(true);
      showToast(`reset:${Date.now()}`, '', `Reset link sent to ${email}.`, 'Password');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="password" className={sectionClass}>
      <h3 className="text-lg font-bold text-ink">Password</h3>
      <p className="mt-3 text-[13px] text-body-soft">You will receive a link to reset your password via email upon clicking the button below.</p>
      {error && <div className="mt-3 max-w-lg"><FormMessage>{error}</FormMessage></div>}
      {sent && <div className="mt-3 max-w-lg"><FormMessage tone="success">{`If ${email} can receive email, a reset link (valid for 30 minutes) is on its way.`}</FormMessage></div>}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={sendLink} disabled={busy} className={outlineButton}>
          {busy ? 'Sending…' : 'Reset password'}
        </button>
        
      </div>
      {changeHere && <PasswordForm />}
    </section>
  );
}

// Not offered by this app yet: said plainly rather than a switch that does nothing
function TwoFactorSection() {
  return (
    <section className={sectionClass}>
      <h3 className="text-lg font-bold text-ink">Two-factor authentication(2FA)</h3>
      <p className="mt-3 max-w-3xl text-[13px] leading-relaxed text-body-soft">
        Two-factor authentication adds an extra layer of security. Once enabled, signing in would require both your password and a one-time verification code
        from an authentication app.
      </p>
      <p className="mt-4 text-[13px] text-danger">Two-factor authentication is not available in this app yet.</p>
    </section>
  );
}

// Every date and time in the app (chats, reports, reminders, snooze) in this zone; saved at once
function TimeZoneSection({ value }: { value: string | null }) {
  const options = useMemo(() => timeZoneOptions(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const workspaceDefault = defaultTimeZone();
  const current = value ?? workspaceDefault;
  const device = currentZoneName(Intl.DateTimeFormat().resolvedOptions().timeZone);

  async function choose(tz: string) {
    if (tz === current) return;
    setBusy(true);
    setError('');
    try {
      await updateMyProfile({ timeZone: tz === workspaceDefault ? '' : tz });
      showToast(`tz:${Date.now()}`, '', `Time zone: ${timeZoneLabel(tz)}.`, 'System preference');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={sectionClass}>
      <h3 className="text-lg font-bold text-ink">System preference</h3>
      <div className="mt-4">
        {label('Your time zone', 'time-zone', 'Dates and times in chats, reports and reminders are shown in this time zone')}
        <SearchSelect
          id="time-zone"
          label="Your time zone"
          value={current}
          options={options.some((o) => o.value === current) ? options : [{ value: current, label: timeZoneLabel(current), offsetMinutes: 0 }, ...options]}
          filter={filterTimeZones}
          onChange={choose}
          placeholder="Search by city, country or UTC offset"
          disabled={busy}
        />
        <p className="mt-1.5 text-[11px] text-faint">
          Times in chats, reports and reminders are shown in this time zone.
          {value === null && ' This is your workspace’s default.'}
          {device && device !== current && (
            <>
              {' '}
              <button type="button" disabled={busy} onClick={() => choose(device)} className="font-medium text-primary hover:underline">
                Use this device&apos;s time zone ({timeZoneLabel(device)})
              </button>
            </>
          )}
        </p>
        {error && <div className="mt-3"><FormMessage>{error}</FormMessage></div>}
      </div>
    </section>
  );
}

// Change it in place: the server checks the current one and stores only a hash; other sessions are signed out
function PasswordForm() {
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const current = String(form.get('current') ?? '');
    const next = String(form.get('password') ?? '');
    const problem = passwordsProblem(next, String(form.get('confirm') ?? ''));
    setError('');
    setDone(false);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      const { token } = await changeMyPassword(current, next);
      setToken(token); // other sessions are signed out; this one carries on with the fresh token
      setDone(true);
      formEl.reset();
      setTimeout(() => window.location.reload(), 1200); // live connections reconnect with the new token
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const type = show ? 'text' : 'password';
  return (
    <form onSubmit={onSubmit} className="mt-5 max-w-lg rounded-xl border border-line p-5">
      <p className="text-xs text-muted">8 or more characters with at least one letter and one number. Your other devices are signed out.</p>
      <div className="mt-4 space-y-3">
        <input name="current" type={type} required autoComplete="current-password" placeholder="Current password" aria-label="Current password" className={inputClass} />
        <input name="password" type={type} required autoComplete="new-password" maxLength={72} placeholder="New password" aria-label="New password" className={inputClass} />
        <input name="confirm" type={type} required autoComplete="new-password" maxLength={72} placeholder="Confirm new password" aria-label="Confirm new password" className={inputClass} />
        <label className="flex items-center gap-2 text-[11px] text-muted">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
          Show passwords
        </label>
        <FormMessage>{error}</FormMessage>
        {done && <FormMessage tone="success">Password changed. Reloading…</FormMessage>}
        <button disabled={busy} className={buttonClass}>
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </div>
    </form>
  );
}

// 'use client';

// import { useState } from 'react';
// import { API_URL } from '@/lib/api';
// import { connectWhatsApp } from '@/lib/settings';
// import { AppShell, type Me } from '../AppShell';
// import { buttonClass, inputClass } from '../AuthShell';
// import { isAdminRole } from '@/lib/roles';
// import { TeamSection } from './team';

// export default function SettingsPage() {
//   // return <AppShell>{(me) => <Settings me={me} />}</AppShell>;
// }

// function Settings({ me }: { me: Me }) {
//   const [connected, setConnected] = useState(me.workspace.whatsapp?.displayPhone ?? null);
//   const [error, setError] = useState('');
//   const [loading, setLoading] = useState(false);
//   const [success, setSuccess] = useState(false);
//   // Only admins may change the WhatsApp connection (the server refuses everyone else)
//   const canEditSettings = isAdminRole(me.role);

//   async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
//     e.preventDefault();
//     setLoading(true);
//     setError('');
//     setSuccess(false);
//     try {
//       const form = new FormData(e.currentTarget);
//       const account = await connectWhatsApp({
//         wabaId: String(form.get('wabaId')),
//         phoneNumberId: String(form.get('phoneNumberId')),
//         accessToken: String(form.get('accessToken')),
//       });
//       setConnected(account.displayPhone);
//       setSuccess(true);
//     } catch (err) {
//       setError((err as Error).message);
//     }
//     setLoading(false);
//   }

//   // return (
//     // <div className="h-full overflow-y-auto bg-page p-6 lg:p-10">
//     //   <div className="mx-auto max-w-2xl space-y-6">
//     //     <div>
//     //       <h1 className="text-xl font-bold tracking-tight text-ink">Workspace Settings</h1>
//     //       <p className="text-xs text-muted mt-0.5">Manage your WhatsApp Business connection and Webhook configuration.</p>
//     //     </div>

      

//     //     {/* <TeamSection meId={me.user.id} role={me.role} />/ */}

        
//     //   </div>
//     // </div>
//   // );
// }




