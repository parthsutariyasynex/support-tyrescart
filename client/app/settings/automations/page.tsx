'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { type Assignee, fetchAssignees } from '@/lib/assignees';
import { type AutomationSettings, type WorkingDay, WEEK, allDay, fetchAutomationSettings, gmtOffset, updateAutomationSettings, workingHoursText } from '@/lib/automations';
import { timeAgo } from '@/lib/contacts';
import { isAdminRole } from '@/lib/roles';
import { showToast } from '@/lib/toasts';
import { AppShell, type Me } from '../../AppShell';
import { EmojiPicker } from '../../inbox/composerExtras';
import { SettingsShell } from '../SettingsShell';

// Settings → Company settings → Simple automations (owners/admins): an automatic reply when a customer writes
// (one during working hours, another outside them) and automatic assignment of new chats to chosen people in turn.
// Changes are saved together with "Save changes"; the server runs the automations for every customer message.
export default function AutomationsPage() {
  return (
    <AppShell>
      {(me) => (
        <SettingsShell me={me} section="Company settings" title="Simple automations">
          <Automations me={me} />
        </SettingsShell>
      )}
    </AppShell>
  );
}

type Editable = Omit<AutomationSettings, 'timeZone' | 'lastAutoReplyAt' | 'variables' | 'replyMaxLength' | 'workingDays' | 'workStart' | 'workEnd'>;
const EDITABLE: (keyof Editable)[] = [
  'enabled',
  'workingHours',
  'replyInHoursEnabled',
  'replyInHours',
  'replyOutHoursEnabled',
  'replyOutHours',
  'cooldownHours',
  'routingEnabled',
  'routingMode',
  'routingMemberIds',
  'routingOnlineOnly',
];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const COOLDOWNS = [1, 4, 8, 12, 24, 48, 72, 168];
const ROUTING_OPTIONS: {
  value: AutomationSettings['routingMode'];
  title: string;
  text: string;
}[] = [
  {
    value: 'specific',
    title: 'Assign to specific teammate',
    text: 'Assign all new conversations to one teammate',
  },
  {
    value: 'round_robin',
    title: 'Round robin',
    text: 'Assign new conversations evenly across selected teammates. Only online teammates will be assigned.',
  },
  {
    value: 'unassigned',
    title: 'Leave unassigned',
    text: 'New conversations stay in the shared Inbox until a teammate picks them up',
  },
];

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors ${checked ? 'bg-success' : 'bg-faint/50'}`}
    >
      <span
        style={{
          backgroundColor: '#fff',
          boxShadow: '0 1px 3px rgb(0 0 0 / 0.3)',
        }}
        className={`inline-block h-5 w-5 rounded-full transition-transform ${checked ? 'translate-x-5' : 'translate-x-0'}`}
      />
    </button>
  );
}

function Automations({ me }: { me: Me }) {
  const router = useRouter();
  const admin = isAdminRole(me.role);
  const [saved, setSaved] = useState<AutomationSettings | null>(null);
  const [form, setForm] = useState<Editable | null>(null);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [hoursOpen, setHoursOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!admin) return router.replace('/settings');
    fetchAutomationSettings()
      .then((s) => {
        setSaved(s);
        setForm(Object.fromEntries(EDITABLE.map((k) => [k, s[k]])) as Editable);
      })
      .catch((e) => setError((e as Error).message));
    fetchAssignees()
      .then((list) => setAssignees(list.filter((a) => a.userId)))
      .catch(() => {});
  }, [admin, router]);
  if (!admin) return null;
  if (!saved || !form)
    return error ? <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p> : <div className="h-96 max-w-4xl animate-pulse rounded-xl bg-surface-strong" aria-busy="true" />;

  const set = <K extends keyof Editable>(k: K, v: Editable[K]) => setForm((f) => ({ ...f!, [k]: v }));
  const changed = EDITABLE.filter((k) => !same(form[k], saved[k]));
  async function save() {
    setBusy(true);
    setError('');
    try {
      const next = await updateAutomationSettings(Object.fromEntries(changed.map((k) => [k, form![k]])));
      setSaved(next);
      setForm(Object.fromEntries(EDITABLE.map((k) => [k, next[k]])) as Editable);
      showToast(`auto:${Date.now()}`, '', 'Simple automations saved.', me.workspace.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const number = me.workspace.whatsapp?.displayPhone;
  // The same rule the server checks, shown under the teammate picker before saving
  const routingProblem =
    form.routingEnabled && form.routingMode !== 'unassigned' && !form.routingMemberIds.length
      ? form.routingMode === 'specific'
        ? 'At least one teammate is required'
        : 'Select at least one teammate'
      : '';

  return (
    <>
      <div className="max-w-4xl">
        <h2 className="text-xl font-bold text-ink">Simple automations</h2>
        <p className="mt-1 text-[13px] text-body-soft">Set up auto-replies and conversation routing from one place</p>

        <section className="mt-5 rounded-xl border border-line bg-surface p-5">
          <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
            <div>
              <span className="flex items-center gap-3 text-[14px] font-medium text-body">
                Enable simple automations
                <Switch checked={form.enabled} onChange={(v) => set('enabled', v)} label="Enable simple automations" />
              </span>
              <p className="mt-2 flex items-center gap-1.5 text-[12px] text-body-soft">
                <span className={`h-2 w-2 rounded-full ${saved.enabled ? 'bg-success' : 'bg-faint'}`} aria-hidden="true" />
                {saved.lastAutoReplyAt ? `Last automatic reply: ${timeAgo(saved.lastAutoReplyAt)}` : 'No automatic replies sent yet'}
              </p>
            </div>
            <span className="hidden h-9 w-px self-center bg-line sm:block" aria-hidden="true" />
            <div className="flex min-w-[260px] flex-1 items-center gap-3">
              <span className="text-[13px] text-muted">for</span>
              <ChannelPicker name={me.workspace.name} phone={number ?? null} />
            </div>
          </div>
        </section>

        <div className="mt-4 flex items-center gap-3 rounded-xl border border-line bg-surface px-5 py-3.5 text-[13px] text-body">
          <svg className="h-5 w-5 shrink-0 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0 0 12 3Z" />
          </svg>
          <p className="min-w-0">
            <span className="font-semibold text-ink">Tips:</span> · Personalise replies with variables like {'{{contact.first_name}}'}; chats answered automatically get the “🤖 Auto-reply” label in
            the inbox.
          </p>
        </div>

        {!form.enabled && (
          <div className="mt-4 flex items-center gap-3 rounded-xl border border-warning-border bg-warning-soft px-5 py-3 text-[13px] text-warning" role="status">
            <span className="font-semibold">Simple automations are off.</span>
            <span className="text-body">No auto-replies are sent and new chats aren&apos;t routed. Your settings below are kept for when you turn it back on.</span>
          </div>
        )}

        {/* Off: everything below is paused, shown greyed out and locked (the settings are kept) */}
        <div inert={!form.enabled} aria-disabled={!form.enabled} className={`transition-opacity ${form.enabled ? '' : 'pointer-events-none select-none opacity-50 grayscale'}`}>
          <p className="mb-3 mt-7 text-[12px] font-bold uppercase tracking-wider text-primary">Set up simple automation</p>

          <section className="rounded-xl border border-line bg-surface p-6">
            <h3 className="flex items-center gap-2.5 text-[15px] font-bold text-ink">
              <svg className="h-5 w-5 text-body-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.4L3 21l2.1-5.7A8.4 8.4 0 1 1 21 11.5Z" />
              </svg>
              Auto-reply
            </h3>
            <WorkingHoursEditor open={hoursOpen} onOpen={setHoursOpen} value={form.workingHours} timeZone={saved.timeZone} onChange={(v) => set('workingHours', v)} />
            <ReplyBlock
              title="Reply during working hours"
              text="Send an automatic welcome message when a customer messages you"
              enabled={form.replyInHoursEnabled}
              onEnabled={(v) => set('replyInHoursEnabled', v)}
              value={form.replyInHours}
              onValue={(v) => set('replyInHours', v)}
              placeholder="Hi {{contact.first_name}}, thanks for reaching out! How can we help you today?"
              settings={saved}
              id="reply-in"
            />
            <ReplyBlock
              title="Reply outside working hours"
              text="Let customers know when you'll get back to them"
              enabled={form.replyOutHoursEnabled}
              onEnabled={(v) => set('replyOutHoursEnabled', v)}
              value={form.replyOutHours}
              onValue={(v) => set('replyOutHours', v)}
              placeholder="Hi {{contact.first_name}}, thanks for your message! We're closed right now and will reply when we're back."
              settings={saved}
              id="reply-out"
            />
            <label className="mt-5 flex flex-wrap items-center gap-2 text-[13px] text-body">
              Don&apos;t send another automatic reply to the same chat within
              <select
                value={form.cooldownHours}
                onChange={(e) => set('cooldownHours', Number(e.target.value))}
                aria-label="Cooldown"
                className="cursor-pointer rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px]"
              >
                {[...new Set([...COOLDOWNS, form.cooldownHours])]
                  .sort((a, b) => a - b)
                  .map((h) => (
                    <option key={h} value={h}>
                      {h === 168 ? '1 week' : `${h} ${h === 1 ? 'hour' : 'hours'}`}
                    </option>
                  ))}
              </select>
            </label>
          </section>

          <section className="mt-5 rounded-xl border border-line bg-surface p-6">
            <div className="flex items-center justify-between gap-4">
              <h3 className="flex items-center gap-2.5 text-[15px] font-bold text-ink">
                <svg className="h-5 w-5 text-body-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="6" cy="5" r="2" />
                  <circle cx="18" cy="19" r="2" />
                  <path d="M6 7v4a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4" />
                </svg>
                Route conversations
              </h3>
              <Switch checked={form.routingEnabled} onChange={(v) => set('routingEnabled', v)} label="Route conversations" />
            </div>
            {form.routingEnabled && (
              <div className="mt-4 space-y-4" role="radiogroup" aria-label="How new conversations are routed">
                {ROUTING_OPTIONS.map((o) => {
                  const on = form.routingMode === o.value;
                  return (
                    <div key={o.value}>
                      <label className="flex cursor-pointer items-start gap-3">
                        <input
                          type="radio"
                          name="routing-mode"
                          checked={on}
                          onChange={() => {
                            set('routingMode', o.value);
                            // one teammate for "specific"; keep the choice when going back to round robin
                            if (o.value === 'specific' && form.routingMemberIds.length > 1) set('routingMemberIds', form.routingMemberIds.slice(0, 1));
                            if (o.value === 'round_robin') set('routingOnlineOnly', true);
                          }}
                          className="mt-0.5 h-[18px] w-[18px] shrink-0 cursor-pointer accent-primary"
                        />
                        <span>
                          <span className="block text-[14px] font-semibold text-ink">{o.title}</span>
                          <span className="block text-[13px] text-body-soft">
                            {o.value === 'round_robin' && !form.routingOnlineOnly ? 'Assign new conversations evenly across selected teammates.' : o.text}
                          </span>
                        </span>
                      </label>
                      {on && o.value !== 'unassigned' && (
                        <TeammatePicker multiple={o.value === 'round_robin'} assignees={assignees} value={form.routingMemberIds} onChange={(ids) => set('routingMemberIds', ids)} />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        {error && <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
      </div>
      <div className="sticky -bottom-6 z-10 -mx-8 -mb-6 mt-6 flex items-center justify-end gap-3 border-t border-line bg-surface px-8 py-3.5">
        <span className="mr-auto text-[12px] text-muted">{changed.length ? `${changed.length} unsaved ${changed.length === 1 ? 'change' : 'changes'}` : 'All changes saved'}</span>
        <button
          type="button"
          disabled={!changed.length || busy}
          onClick={() => setForm(Object.fromEntries(EDITABLE.map((k) => [k, saved[k]])) as Editable)}
          className="min-w-24 rounded-lg border border-primary px-5 py-2 text-[13px] font-semibold text-primary hover:bg-primary/5 disabled:border-line disabled:text-faint disabled:hover:bg-transparent"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!changed.length || busy || !!routingProblem || !!hoursProblem(form.workingHours)}
          title={routingProblem || hoursProblem(form.workingHours) || undefined}
          onClick={save}
          className="min-w-24 rounded-lg bg-primary px-5 py-2 text-[13px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  );
}

const WHATSAPP_ICON = (
  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#25d366] text-[#fff]" aria-hidden="true">
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm5.3 14.2c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.3-.7-2.8-1.1-4.5-3.9-4.7-4.1-.1-.2-1.1-1.5-1.1-2.8s.7-2 1-2.3c.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .5l-.4.6-.4.4c-.1.2-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.4 2.4 1.5.3.2.5.1.6 0l.9-1c.2-.3.4-.2.6-.1l1.9.9c.3.1.5.2.5.3.1.2.1.7-.2 1.4Z" />
    </svg>
  </span>
);

// The channel simple automations run on: this workspace's WhatsApp number (or a way to connect one)
function ChannelPicker({ name, phone }: { name: string; phone: string | null }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="relative min-w-0 flex-1" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Channel"
        className={`flex w-full items-center gap-2.5 rounded-lg border bg-surface px-3 py-2 text-left text-[13px] ${open ? 'border-primary ring-2 ring-primary/15' : 'border-line hover:border-line-strong'}`}
      >
        {phone ? (
          <>
            {WHATSAPP_ICON}
            <span className="truncate font-semibold text-ink">{name}</span>
            <span className="truncate text-muted">{phone}</span>
          </>
        ) : (
          <span className="truncate text-muted">No WhatsApp number connected: replies can&apos;t be sent until one is</span>
        )}
        <svg
          className={`ml-auto h-4 w-4 shrink-0 text-muted transition ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div role="listbox" className="absolute inset-x-0 top-full z-20 mt-1 rounded-lg border border-line bg-surface py-1 shadow-lg">
          {phone && (
            <div role="option" aria-selected="true" className="flex items-center gap-2.5 px-3.5 py-2.5 text-[13px]">
              {WHATSAPP_ICON}
              <span className="truncate text-ink">{name}</span>
              <span className="truncate text-muted">{phone}</span>
              <span className="ml-auto text-primary" aria-hidden="true">
                ✓
              </span>
            </div>
          )}
          {phone && <div className="my-1 border-t border-line" />}
          <Link href="/settings" className="flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] font-medium text-primary hover:bg-surface-muted">
            <span className="w-6 text-center text-[18px] leading-none" aria-hidden="true">
              +
            </span>
            {phone ? 'Manage channel' : 'Connect a channel'}
          </Link>
        </div>
      )}
    </div>
  );
}

// Searchable teammate dropdown: one teammate ("specific") or several (round robin), with the required-choice message
function TeammatePicker({ multiple, assignees, value, onChange }: { multiple: boolean; assignees: Assignee[]; value: string[]; onChange: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const picked = assignees.filter((a) => value.includes(a.id));
  const q = query.trim().toLowerCase();
  const shown = q ? assignees.filter((a) => a.name.toLowerCase().includes(q)) : assignees;
  const pick = (id: string) => {
    if (!multiple) {
      onChange([id]);
      setOpen(false);
      setQuery('');
    } else onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  };
  const summary = picked.map((a) => a.name).join(', ');
  return (
    <div className="ml-[30px] mt-3" ref={box}>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wider text-body">{multiple ? 'Select teammates' : 'Select teammate'}</span>
        {multiple && (
          <span className="text-[12px] text-muted">
            {picked.length} of {assignees.length} selected
          </span>
        )}
      </div>
      <div className="relative">
        <div
          className={`flex items-center gap-2.5 rounded-lg border bg-surface px-3.5 py-2.5 ${open ? 'border-primary ring-2 ring-primary/15' : !value.length ? 'border-danger/60' : 'border-line'}`}
          onClick={() => setOpen(true)}
        >
          <svg className="h-4 w-4 shrink-0 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            value={open ? query : ''}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
            placeholder={summary && !open ? summary : 'Search teammates'}
            aria-label={multiple ? 'Search teammates' : 'Search teammate'}
            className={`min-w-0 flex-1 bg-transparent text-[13px] outline-none ${summary && !open ? 'placeholder:text-ink' : 'placeholder:text-faint'}`}
          />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
            aria-label={open ? 'Close the list' : 'Open the list'}
            className="text-muted hover:text-ink"
          >
            <svg
              className={`h-4 w-4 transition ${open ? 'rotate-180' : ''}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>
        {open && (
          <ul role="listbox" aria-multiselectable={multiple} className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-lg">
            {shown.map((a) => {
              const on = value.includes(a.id);
              return (
                <li key={a.id} role="option" aria-selected={on}>
                  <button
                    type="button"
                    onClick={() => pick(a.id)}
                    className={`flex w-full items-center gap-3 px-3.5 py-2 text-left text-[13px] hover:bg-surface-muted ${on && !multiple ? 'bg-primary/5' : ''}`}
                  >
                    {multiple && <input type="checkbox" readOnly checked={on} tabIndex={-1} className="pointer-events-none h-4 w-4 accent-primary" />}
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-on-primary" style={{ backgroundColor: a.color }} aria-hidden="true">
                      {a.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="truncate text-ink">{a.name}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-faint">{a.conversationCount} chats</span>
                    {on && !multiple && (
                      <span className="text-primary" aria-hidden="true">
                        ✓
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
            {!shown.length && <li className="px-3.5 py-3 text-[13px] text-muted">No teammates match “{query}”</li>}
          </ul>
        )}
      </div>
      {!value.length && <p className="mt-1.5 text-[12px] text-danger">{multiple ? 'Select at least one teammate' : 'At least one teammate is required'}</p>}
    </div>
  );
}

// One reply (during or outside working hours): on/off, the text with emojis and {{variables}}, and a counter
function ReplyBlock({
  id,
  title,
  text,
  enabled,
  onEnabled,
  value,
  onValue,
  placeholder,
  settings,
}: {
  id: string;
  title: string;
  text: string;
  enabled: boolean;
  onEnabled: (v: boolean) => void;
  value: string;
  onValue: (v: string) => void;
  placeholder: string;
  settings: AutomationSettings;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [varsOpen, setVarsOpen] = useState(false);
  const insert = (s: string) => {
    const el = ref.current;
    const at = el ? el.selectionStart : value.length;
    const end = el ? el.selectionEnd : value.length;
    const next = (value.slice(0, at) + s + value.slice(end)).slice(0, settings.replyMaxLength);
    onValue(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + s.length, at + s.length);
    });
  };
  return (
    <div className={`mt-6 border-l-4 pl-4 ${enabled ? 'border-success' : 'border-line'}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[14px] font-semibold text-ink">{title}</p>
          <p className="text-[13px] text-body-soft">{text}</p>
        </div>
        <Switch checked={enabled} onChange={onEnabled} label={title} />
      </div>
      <label htmlFor={id} className="mb-1.5 mt-4 block text-[12px] font-semibold text-body">
        Reply message
      </label>
      <div className="rounded-xl border border-line bg-surface focus-within:border-primary">
        <textarea
          id={id}
          ref={ref}
          value={value}
          onChange={(e) => onValue(e.target.value.slice(0, settings.replyMaxLength))}
          rows={5}
          placeholder={placeholder}
          className="w-full resize-y rounded-t-xl bg-transparent px-4 py-3 text-[14px] text-ink outline-hidden placeholder:text-faint"
        />
        <div className="relative flex items-center gap-1 border-t border-line-soft px-2 py-1.5">
          <div className="relative">
            {emojiOpen && (
              <EmojiPicker
                onPick={(e) => {
                  insert(e);
                  setEmojiOpen(false);
                }}
                onClose={() => setEmojiOpen(false)}
              />
            )}
            <button
              type="button"
              data-emoji-toggle
              onClick={() => setEmojiOpen((o) => !o)}
              aria-label="Add emoji"
              title="Add emoji"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-body-soft hover:bg-surface-muted"
            >
              😊
            </button>
          </div>
          <div className="relative">
            <button
              type="button"
              onClick={() => setVarsOpen((o) => !o)}
              aria-label="Insert a variable"
              aria-expanded={varsOpen}
              title="Insert a variable"
              className="flex h-8 items-center rounded-lg px-2 font-mono text-[13px] italic text-body-soft hover:bg-surface-muted"
            >
              (x)
            </button>
            {varsOpen && (
              <ul role="menu" aria-label="Variables" className="absolute bottom-full left-0 z-30 mb-1 max-h-72 w-64 overflow-y-auto rounded-xl border border-line bg-surface py-1 shadow-xl">
                {settings.variables.map((v) => (
                  <li key={v.key}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        insert(`{{${v.key}}}`);
                        setVarsOpen(false);
                      }}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] text-ink hover:bg-surface-muted"
                    >
                      {v.label}
                      <span className="font-mono text-[10px] text-faint">{`{{${v.key}}}`}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <span className="ml-auto pr-2 text-[11px] tabular-nums text-faint">
            {value.length}/{settings.replyMaxLength}
          </span>
        </div>
      </div>
    </div>
  );
}

const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const PRESETS = [
  { label: '9 AM – 5 PM', start: '09:00', end: '17:00' },
  { label: '9 AM – 6 PM', start: '09:00', end: '18:00' },
  { label: '24/7', start: '00:00', end: '23:59' },
];
const hoursProblem = (list: WorkingDay[]) => (!list.length ? 'Turn on at least one working day' : list.some((h) => h.end <= h.start) ? 'Working hours must end after they start' : '');

// Working hours, edited in place (as in SleekFlow): a switch and its own hours for each day, and quick presets.
// The changes are saved with the rest of the page.
function WorkingHoursEditor({ open, onOpen, value, timeZone, onChange }: { open: boolean; onOpen: (v: boolean) => void; value: WorkingDay[]; timeZone: string; onChange: (v: WorkingDay[]) => void }) {
  const sorted = (list: WorkingDay[]) => WEEK.map((d) => list.find((h) => h.day === d)).filter((h): h is WorkingDay => !!h);
  const setDay = (day: number, h: Omit<WorkingDay, 'day'> | null) => onChange(sorted([...value.filter((x) => x.day !== day), ...(h ? [{ day, ...h }] : [])]));
  // 9–5 and 9–6 keep the days that are on (Monday to Friday if none are); 24/7 opens every day
  const preset = (p: (typeof PRESETS)[number]) => {
    const days = allDay(p) ? WEEK : value.length ? value.map((h) => h.day) : [1, 2, 3, 4, 5];
    onChange(sorted(days.map((day) => ({ day, start: p.start, end: p.end }))));
  };
  const presetOn = (p: (typeof PRESETS)[number]) => value.length > 0 && value.every((h) => h.start === p.start && h.end === p.end) && (!allDay(p) || value.length === 7);
  const problem = hoursProblem(value);
  const timeClass = 'w-36 rounded-lg border bg-surface px-3 py-2 text-[13px] text-ink';
  return (
    <div className="mt-4 rounded-xl border border-line bg-surface-muted px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2.5 text-[13px] font-medium text-ink">
          <svg className="h-[18px] w-[18px] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          Working hours: {workingHoursText({ workingHours: value, timeZone })}
        </p>
        <button type="button" onClick={() => onOpen(!open)} aria-expanded={open} className="text-[13px] font-semibold text-primary hover:underline">
          {open ? 'Close' : 'Edit working hours'}
        </button>
      </div>
      {open && (
        <>
          <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Quick hours">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                aria-pressed={presetOn(p)}
                onClick={() => preset(p)}
                className={`rounded-full border px-3.5 py-1.5 text-[13px] font-semibold transition ${presetOn(p) ? 'border-primary bg-primary/10 text-primary' : 'border-line bg-surface text-ink hover:border-line-strong'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <ul className="mt-3" aria-label="Working days">
            {WEEK.map((day) => {
              const h = value.find((x) => x.day === day);
              const bad = !!h && h.end <= h.start;
              return (
                <li key={day} className="flex min-h-[64px] flex-wrap items-center gap-x-4 gap-y-1 border-b border-line py-3">
                  <Switch checked={!!h} onChange={(on) => setDay(day, on ? { start: value[0]?.start ?? '09:00', end: value[0]?.end ?? '18:00' } : null)} label={`${DAY_FULL[day]} open`} />
                  <span className={`w-28 text-[14px] ${h ? 'text-ink' : 'text-body-soft'}`}>{DAY_FULL[day]}</span>
                  {h ? (
                    <span className="flex flex-wrap items-center gap-3">
                      <input
                        type="time"
                        value={h.start}
                        onChange={(e) => e.target.value && setDay(day, { start: e.target.value, end: h.end })}
                        aria-label={`${DAY_FULL[day]} opens at`}
                        className={`${timeClass} ${bad ? 'border-danger' : 'border-line'}`}
                      />
                      <span className="text-body-soft" aria-hidden="true">
                        –
                      </span>
                      <input
                        type="time"
                        value={h.end}
                        onChange={(e) => e.target.value && setDay(day, { start: h.start, end: e.target.value })}
                        aria-label={`${DAY_FULL[day]} closes at`}
                        className={`${timeClass} ${bad ? 'border-danger' : 'border-line'}`}
                      />
                      {allDay(h) && <span className="text-[12px] text-muted">24 hours</span>}
                      {bad && <span className="w-full text-[12px] text-danger">Closing time must be after opening time</span>}
                    </span>
                  ) : (
                    <span className="text-[14px] text-body-soft">Closed</span>
                  )}
                </li>
              );
            })}
          </ul>
          {!value.length && <p className="mt-2 text-[12px] text-danger">{problem}</p>}
        </>
      )}
      <p className="mt-3 text-[12px] text-body-soft">
        Working hours apply across your workspace, in its time zone ({timeZone}, {gmtOffset(timeZone)};{' '}
        <Link href="/settings/workspace" className="underline hover:text-primary">
          Workspace preferences
        </Link>
        ).
      </p>
    </div>
  );
}
