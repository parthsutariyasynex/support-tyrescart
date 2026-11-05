'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { renameWorkspace } from '@/lib/auth';
import { type WorkingDay, WEEK, fetchAutomationSettings, updateAutomationSettings, workingHoursText } from '@/lib/automations';
import { timeZoneLabel } from '@/lib/profileOptions';
import { isAdminRole } from '@/lib/roles';
import { APP_TIME_ZONE } from '@/lib/time';
import { type WhatsAppCheck, connectWhatsApp } from '@/lib/settings';
import { showToast } from '@/lib/toasts';
import { AppShell, type Me } from '../../AppShell';
import { ConfirmDialog } from '../../ConfirmDialog';
import { SettingsShell } from '../SettingsShell';

// Settings → Company details (owners and admins): the company name, its business hours (the working hours Simple
// automations use, the same ones as on that page) and, on the other tab, the WhatsApp connection and its
// Connect / Update form
export default function CompanyPage() {
  return (
    <AppShell>
      {(me) => (
        <SettingsShell me={me} section="Company settings" title="Company details">
          <Company me={me} />
        </SettingsShell>
      )}
    </AppShell>
  );
}

const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const sameHours = (a: WorkingDay[], b: WorkingDay[]) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (list: WorkingDay[]) => WEEK.map((d) => list.find((h) => h.day === d)).filter((h): h is WorkingDay => !!h);
const input = 'w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/15';
const readOnly = 'w-full rounded-lg border border-line bg-surface-muted px-3 py-2.5 text-[13px] text-body';

function Company({ me }: { me: Me }) {
  const router = useRouter();
  const admin = isAdminRole(me.role);
  const [tab, setTab] = useState<'info' | 'whatsapp'>('info');
  const [name, setName] = useState(me.workspace.name);
  const [savedHours, setSavedHours] = useState<WorkingDay[] | null>(null);
  const [hours, setHours] = useState<WorkingDay[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!admin) return router.replace('/settings');
    fetchAutomationSettings()
      .then((s) => {
        setSavedHours(s.workingHours);
        setHours(s.workingHours);
      })
      .catch((e) => setError((e as Error).message));
  }, [admin, router]);
  useEffect(() => setName(me.workspace.name), [me.workspace.name]);
  if (!admin) return null;

  const nameChanged = name.trim() !== me.workspace.name;
  const hoursChanged = !!savedHours && !sameHours(hours, savedHours);
  const problem = !name.trim()
    ? 'Enter the company name'
    : !hours.length
      ? 'Choose at least one business day'
      : hours.some((h) => h.end <= h.start)
        ? 'Closing time must be after opening time'
        : '';
  const changes = (nameChanged ? 1 : 0) + (hoursChanged ? 1 : 0);

  async function save() {
    setBusy(true);
    setError('');
    try {
      if (nameChanged) await renameWorkspace(name.trim());
      if (hoursChanged) {
        const s = await updateAutomationSettings({ workingHours: hours });
        setSavedHours(s.workingHours);
        setHours(s.workingHours);
      }
      showToast(`company:${Date.now()}`, '', 'Company details saved.', name.trim());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function cancel() {
    setName(me.workspace.name);
    if (savedHours) setHours(savedHours);
    setError('');
  }
  const setDay = (day: number, h: Omit<WorkingDay, 'day'> | null) => setHours((list) => sorted([...list.filter((x) => x.day !== day), ...(h ? [{ day, ...h }] : [])]));

  const wa = me.workspace.whatsapp;
  const row = (label: string, value: React.ReactNode, mono = false) => (
    <div className="grid grid-cols-[200px_1fr] gap-4 px-5 py-3.5">
      <dt className="text-[12px] font-semibold text-muted">{label}</dt>
      <dd className={`break-all text-[13px] text-ink ${mono ? 'font-mono text-[12px]' : ''}`}>{value}</dd>
    </div>
  );

  return (
    <>
      <div className="max-w-4xl">
        <div className="flex gap-6 border-b border-line" role="tablist">
          {(
            [
              ['info', 'Company info'],
              ['whatsapp', 'WhatsApp'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`-mb-px border-b-2 pb-2.5 text-[14px] font-semibold transition ${tab === key ? 'border-primary text-primary' : 'border-transparent text-body-soft hover:text-ink'}`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'info' ? (
          <>
            <section className="mt-5 rounded-xl border border-line bg-surface p-6">
              <h3 className="text-[15px] font-bold text-ink">Company information</h3>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="block text-[12px] font-semibold text-body" htmlFor="company-name">
                  Company name
                  <input id="company-name" value={name} maxLength={191} onChange={(e) => setName(e.target.value)} className={`${input} mt-1.5 font-normal`} />
                  <span className="mt-1 block text-[11px] font-normal text-faint">Shown across the app and in auto-replies as {'{{company.name}}'}</span>
                </label>
                <div className="text-[12px] font-semibold text-body">
                  Company ID
                  <div className="mt-1.5 flex gap-2">
                    <p className={`${readOnly} truncate font-mono text-[12px]`}>{me.workspace.id}</p>
                    <button
                      type="button"
                      onClick={() =>
                        navigator.clipboard
                          ?.writeText(me.workspace.id)
                          .then(() => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1500);
                          })
                          .catch(() => {})
                      }
                      className="shrink-0 rounded-lg border border-line px-3 text-[12px] font-semibold text-primary hover:bg-surface-muted"
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
                <div className="text-[12px] font-semibold text-body">
                  Time zone
                  <p className={`${readOnly} mt-1.5 font-normal`}>{timeZoneLabel(APP_TIME_ZONE)}</p>
                </div>
                <div className="text-[12px] font-semibold text-body">
                  WhatsApp number
                  <p className={`${readOnly} mt-1.5 font-normal`}>{wa?.displayPhone ?? 'Not connected'}</p>
                </div>
              </div>
            </section>

            <section className="mt-5 rounded-xl border border-line bg-surface p-6">
              <h3 className="text-[15px] font-bold text-ink">Business hours</h3>
              <p className="mt-1 text-[13px] text-body-soft">
                When your team is available. Simple automations use these hours to send the “during working hours” or “outside working hours” auto-reply.
              </p>
              {savedHours && <p className="mt-2 text-[12px] font-medium text-ink">{workingHoursText({ workingHours: hours, timeZone: APP_TIME_ZONE })}</p>}
              {!savedHours && !error && <div className="mt-4 h-64 animate-pulse rounded-lg bg-surface-strong" aria-busy="true" />}
              {savedHours && (
                <ul className="mt-3" aria-label="Business hours">
                  {WEEK.map((day) => {
                    const h = hours.find((x) => x.day === day);
                    const bad = !!h && h.end <= h.start;
                    return (
                      <li key={day} className="flex min-h-[60px] flex-wrap items-center gap-x-4 gap-y-1 border-b border-line py-2.5 last:border-b-0">
                        <label className="flex w-40 cursor-pointer items-center gap-3 text-[14px]">
                          <input
                            type="checkbox"
                            checked={!!h}
                            onChange={(e) => setDay(day, e.target.checked ? { start: hours[0]?.start ?? '09:00', end: hours[0]?.end ?? '18:00' } : null)}
                            className="h-[18px] w-[18px] cursor-pointer accent-primary"
                          />
                          <span className={h ? 'text-ink' : 'text-body-soft'}>{DAY_FULL[day]}</span>
                        </label>
                        {h ? (
                          <span className="flex flex-wrap items-center gap-3">
                            <input
                              type="time"
                              value={h.start}
                              onChange={(e) => e.target.value && setDay(day, { start: e.target.value, end: h.end })}
                              aria-label={`${DAY_FULL[day]} opens at`}
                              className={`w-40 rounded-lg border bg-surface px-3 py-2 text-[13px] text-ink ${bad ? 'border-danger' : 'border-line'}`}
                            />
                            <span className="text-body-soft" aria-hidden="true">
                              –
                            </span>
                            <input
                              type="time"
                              value={h.end}
                              onChange={(e) => e.target.value && setDay(day, { start: h.start, end: e.target.value })}
                              aria-label={`${DAY_FULL[day]} closes at`}
                              className={`w-40 rounded-lg border bg-surface px-3 py-2 text-[13px] text-ink ${bad ? 'border-danger' : 'border-line'}`}
                            />
                            {bad && <span className="w-full text-[12px] text-danger">Closing time must be after opening time</span>}
                          </span>
                        ) : (
                          <span className="text-[14px] text-body-soft">Closed</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="mt-3 text-[12px] text-body-soft">Business hours apply across your workspace, in Dubai time.</p>
            </section>
          </>
        ) : (
          <section className="mt-5">
            <dl className="divide-y divide-line-soft rounded-xl border border-line bg-surface">
              {row(
                'Status',
                wa?.displayPhone ? (
                  <span className="inline-flex items-center gap-1.5 font-semibold text-primary">
                    <span className="h-2 w-2 rounded-full bg-accent" /> Connected
                  </span>
                ) : (
                  <span className="font-semibold text-warning">Not connected</span>
                ),
              )}
              {row('Business number', wa?.displayPhone ?? '–')}
              {row('Phone number ID', wa?.phoneNumberId ?? '–', true)}
              {row('WhatsApp Business account ID', wa?.wabaId ?? '–', true)}
            </dl>
            <ConnectWhatsApp current={wa} />
          </section>
        )}
        {error && <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
      </div>

      {tab === 'info' && (
        <div className="sticky -bottom-6 z-10 -mx-8 -mb-6 mt-6 flex items-center justify-end gap-3 border-t border-line bg-surface px-8 py-3.5">
          <span className="mr-auto text-[12px] text-muted">{changes ? `${changes} unsaved ${changes === 1 ? 'change' : 'changes'}` : 'All changes saved'}</span>
          <button
            type="button"
            disabled={!changes || busy}
            onClick={cancel}
            className="min-w-24 rounded-lg border border-primary px-5 py-2 text-[13px] font-semibold text-primary hover:bg-primary/5 disabled:border-line disabled:text-faint disabled:hover:bg-transparent"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!changes || busy || !!problem}
            title={problem || undefined}
            onClick={save}
            className="min-w-24 rounded-lg bg-primary px-5 py-2 text-[13px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </>
  );
}

// Connect a number, or update / replace the connected one. The server runs 7 checks with Meta (token, app, permanent
// System User token, permissions, account, number, webhooks) and saves nothing unless all pass; a replaced number's
// credentials are kept as a backup on the server. The token is sent once and never shown again.
const CHECK_NAMES = ['Access token', 'Meta app', 'Permanent token', 'Permissions', 'WhatsApp Business account', 'Phone number', 'Webhooks'];

function ConnectWhatsApp({ current }: { current: Me['workspace']['whatsapp'] }) {
  const [wabaId, setWabaId] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checks, setChecks] = useState<WhatsAppCheck[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const connected = !!current?.displayPhone;
  const replacing = connected && !!phoneNumberId.trim() && phoneNumberId.trim() !== current?.phoneNumberId;
  const ready = !!wabaId.trim() && !!phoneNumberId.trim() && accessToken.trim().length >= 10;

  async function connect() {
    setBusy(true);
    setError('');
    setChecks(null);
    try {
      const account = await connectWhatsApp({ wabaId: wabaId.trim(), phoneNumberId: phoneNumberId.trim(), accessToken: accessToken.trim() });
      setChecks(account.checks ?? []);
      setAccessToken('');
      setConfirming(false);
      showToast(`whatsapp:${Date.now()}`, '', 'WhatsApp connected', `${account.displayPhone} passed all 7 checks. Reloading…`);
      setTimeout(() => window.location.reload(), 3000); // every page shows the new number after the reload
    } catch (e) {
      setError((e as Error).message);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  const field = (id: string, label: string, value: string, set: (v: string) => void, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="block text-[12px] font-semibold text-body" htmlFor={id}>
      {label}
      <input id={id} value={value} onChange={(e) => set(e.target.value)} disabled={busy} className={`${input} mt-1.5 font-mono font-normal`} {...props} />
    </label>
  );

  return (
    <form
      className="mt-5 rounded-xl border border-line bg-surface p-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || busy) return;
        if (replacing) setConfirming(true);
        else void connect();
      }}
    >
      <h3 className="text-[15px] font-bold text-ink">{connected ? 'Update WhatsApp connection' : 'Connect WhatsApp'}</h3>
      <p className="mt-1 text-[13px] text-body-soft">
        From Meta: WhatsApp Manager (account and phone number IDs) and Business Settings → System users (a token that never expires, with whatsapp_business_messaging and
        whatsapp_business_management). Nothing is saved unless all 7 checks with Meta pass.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {field('waba-id', 'WhatsApp Business account ID', wabaId, setWabaId, { inputMode: 'numeric', autoComplete: 'off', placeholder: current?.wabaId || '' })}
        {field('phone-number-id', 'Phone number ID', phoneNumberId, setPhoneNumberId, { inputMode: 'numeric', autoComplete: 'off', placeholder: current?.phoneNumberId || '' })}
        <div className="sm:col-span-2">
          {field('access-token', 'Permanent access token (System User)', accessToken, setAccessToken, { type: 'password', autoComplete: 'off', spellCheck: false })}
          <span className="mt-1 block text-[11px] text-faint">Sent once to verify and save; it is never shown again.</span>
        </div>
      </div>

      {checks && (
        <ul className="mt-4 space-y-1.5" aria-label="Checks with Meta">
          {checks.map((c, i) => (
            <li key={c.name} className="flex gap-2 text-[12px]">
              <span className={c.ok ? 'text-primary' : 'text-danger'}>{c.ok ? '✓' : '✗'}</span>
              <span className="font-semibold text-ink">
                {i + 1}. {c.name}
              </span>
              <span className="text-body-soft">{c.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {busy && <p className="mt-4 text-[12px] text-body-soft">Checking with Meta: {CHECK_NAMES.join(' · ')}…</p>}
      {error && <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error} Nothing was changed.</p>}

      <div className="mt-5 flex justify-end">
        <button type="submit" disabled={!ready || busy} className="min-w-24 rounded-lg bg-primary px-5 py-2 text-[13px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50">
          {busy ? 'Checking…' : connected ? 'Verify and update' : 'Verify and connect'}
        </button>
      </div>

      {confirming && (
        <ConfirmDialog
          title={`Replace ${current?.displayPhone}?`}
          body={`The whole workspace will send and receive from the new number (shown after the checks pass). Messages to ${current?.displayPhone} stop arriving here. Its credentials are kept as a backup on the server.`}
          yes="Verify and replace"
          danger
          busy={busy}
          error={error}
          onYes={() => void connect()}
          onNo={() => setConfirming(false)}
        />
      )}
    </form>
  );
}
