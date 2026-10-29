'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ME_CHANGED_EVENT } from '@/lib/auth';
import { filterCountries, phoneCountries, timeZoneLabel } from '@/lib/profileOptions';
import { isAdminRole } from '@/lib/roles';
import { showToast } from '@/lib/toasts';
import { type WorkspaceSettings, fetchWorkspaceSettings, updateWorkspaceSettings } from '@/lib/workspaceSettings';
import { AppShell, type Me } from '../../AppShell';
import { inputClass } from '../../AuthShell';
import { SearchSelect } from '../../SearchSelect';
import { SettingsShell } from '../SettingsShell';

// Settings → Company settings → Workspace preferences (owners/admins): the workspace-wide defaults and timings that
// used to be fixed in the app. Everyone's app follows them; a person's own time zone (General) still wins over the
// default one.
export default function WorkspacePreferencesPage() {
  return (
    <AppShell>
      {(me) => (
        <SettingsShell me={me} section="Company settings" title="Workspace preferences">
          <Preferences me={me} />
        </SettingsShell>
      )}
    </AppShell>
  );
}

const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }));

function Preferences({ me }: { me: Me }) {
  const router = useRouter();
  const admin = isAdminRole(me.role);
  const [saved, setSaved] = useState<WorkspaceSettings | null>(null);
  const [form, setForm] = useState<WorkspaceSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const countries = useMemo(() => phoneCountries().map((c) => ({ value: c.code, label: `${c.flag} ${c.name} (+${c.dial})` })), []);
  useEffect(() => {
    if (!admin) {
      router.replace('/settings');
      return;
    }
    fetchWorkspaceSettings()
      .then((s) => {
        setSaved(s);
        setForm(s);
      })
      .catch((e) => setError((e as Error).message));
  }, [admin, router]);
  if (!admin) return null;
  if (!form || !saved) return error ? <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p> : <PageSkeleton />;

  const set = <K extends keyof WorkspaceSettings>(k: K, v: WorkspaceSettings[K]) => setForm({ ...form, [k]: v });
  const changed = (Object.keys(form) as (keyof WorkspaceSettings)[]).filter((k) => form[k] !== saved[k]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!changed.length) return;
    setBusy(true);
    setError('');
    try {
      const next = await updateWorkspaceSettings(Object.fromEntries(changed.map((k) => [k, form![k]])) as Partial<WorkspaceSettings>);
      setSaved(next);
      setForm(next);
      window.dispatchEvent(new Event(ME_CHANGED_EVENT)); // this app picks up the new defaults now
      showToast(`ws:${Date.now()}`, '', 'Workspace preferences saved.', me.workspace.name);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const num = (k: 'reminderMinutes' | 'awayMinutes' | 'deletedContactRetentionDays' | 'pinLimit', min: number, max: number, unit: string) => (
    <div className="flex items-center gap-2">
      <input
        id={k}
        type="number"
        min={min}
        max={max}
        value={typeof form[k] === 'number' && Number.isFinite(form[k]) ? (form[k] as number) : ''}
        onChange={(e) => set(k, e.target.value === '' ? Number.NaN : Number(e.target.value))}
        className={`${inputClass} !w-28`}
      />
      <span className="text-[13px] text-body-soft">{unit}</span>
    </div>
  );

  return (
    <form onSubmit={save} className="max-w-3xl">
      <Section title="Regional defaults" text="Used for everyone in this workspace unless they choose otherwise.">
        <Field label="Time zone" htmlFor="ws-tz" hint="All dates and times (chats, reports, reminders, automation working hours) are shown in Dubai time.">
          <p id="ws-tz" className="rounded-lg border border-line bg-surface-muted px-3 py-2 text-[13px] text-ink">
            {timeZoneLabel(saved.defaultTimeZone)}
          </p>
        </Field>
        <Field label="Default phone country" htmlFor="ws-country" hint="Preselected when someone enters a phone number.">
          <SearchSelect
            id="ws-country"
            label="Default phone country"
            value={form.defaultCountry}
            options={countries}
            filter={filterCountries}
            onChange={(v) => set('defaultCountry', v)}
            placeholder="Search countries"
          />
        </Field>
        <Field label="Business day starts at" htmlFor="ws-hour" hint="Snooze “Tomorrow” and “Monday” wake chats at this time.">
          <select id="ws-hour" value={String(form.businessDayStartHour)} onChange={(e) => set('businessDayStartHour', Number(e.target.value))} className={`${inputClass} !w-40 cursor-pointer`}>
            {HOURS.map((h) => (
              <option key={h.value} value={h.value}>
                {h.label}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      <Section title="Team" text="How the inbox keeps your team on top of chats.">
        <Field label="Remind about unattended chats after" htmlFor="reminderMinutes" hint="Assigned chats nobody opened, and unassigned chats with new messages, remind the team after this time and again at the same interval. 0 turns reminders off.">
          {num('reminderMinutes', 0, 1440, 'minutes')}
        </Field>
        <Field label="Show people as Away after" htmlFor="awayMinutes" hint="Idle time (no activity in the app) before someone's status changes from Online to Away.">
          {num('awayMinutes', 1, 240, 'minutes')}
        </Field>
        <Field label="Pinned chats and messages" htmlFor="pinLimit" hint="Owners and admins pin chats (at the top of everyone's list) and messages (in a bar at the top of the chat) for the whole team. This is the most pinned chats, and the most pinned messages in one chat. Lowering it never unpins anything.">
          {num('pinLimit', 1, 50, 'chats · messages per chat')}
        </Field>
      </Section>

      <Section title="Data" text="What happens to deleted contacts.">
        <Field label="Keep deleted contacts for" htmlFor="deletedContactRetentionDays" hint="Restorable from Recently deleted contacts during this time; then removed for good with their chat.">
          {num('deletedContactRetentionDays', 1, 90, 'days')}
        </Field>
      </Section>

      {error && <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
      <div className="sticky bottom-0 mt-6 flex items-center justify-end gap-2 border-t border-line bg-page py-4">
        <span className="mr-auto text-[12px] text-muted">{changed.length ? `${changed.length} unsaved ${changed.length === 1 ? 'change' : 'changes'}` : 'All changes saved'}</span>
        <button type="button" disabled={!changed.length || busy} onClick={() => setForm(saved)} className="rounded-lg px-4 py-2 text-[13px] text-body-soft hover:bg-surface-muted disabled:opacity-40">
          Discard
        </button>
        <button type="submit" disabled={!changed.length || busy} className="rounded-lg bg-primary px-5 py-2 text-[13px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50">
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

function Section({ title, text, children }: { title: string; text: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 rounded-xl border border-line bg-surface p-6">
      <h3 className="text-[15px] font-bold text-ink">{title}</h3>
      <p className="mt-1 text-[12px] text-muted">{text}</p>
      <div className="mt-5 space-y-5">{children}</div>
    </section>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-muted">
        {label}
      </label>
      {children}
      <p className="mt-1.5 text-[11px] text-faint">{hint}</p>
    </div>
  );
}

// Same shape as the form while it loads, so nothing jumps when the values arrive
function PageSkeleton() {
  return (
    <div className="max-w-3xl space-y-6" aria-busy="true" aria-label="Loading">
      {[3, 2, 1].map((n) => (
        <div key={n} className="rounded-xl border border-line bg-surface p-6">
          <div className="h-4 w-40 animate-pulse rounded bg-surface-strong" />
          <div className="mt-2 h-3 w-64 animate-pulse rounded bg-surface-strong" />
          {Array.from({ length: n }, (_, i) => (
            <div key={i} className="mt-5 h-10 w-full animate-pulse rounded-lg bg-surface-strong" />
          ))}
        </div>
      ))}
    </div>
  );
}
