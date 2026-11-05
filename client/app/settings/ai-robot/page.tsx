'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  type AiRobotInput,
  type AiRobotSettings,
  type AiRobotTest,
  type AiRobotTestChat,
  fetchAiRobotSettings,
  fetchAiRobotTestChats,
  testAiRobot,
  toolText,
  updateAiRobotSettings,
} from '@/lib/aiRobot';
import { formatDateTime } from '@/lib/time';
import { isAdminRole } from '@/lib/roles';
import { showToast } from '@/lib/toasts';
import { AppShell, type Me } from '../../AppShell';
import { SettingsShell } from '../SettingsShell';

// Settings → Company settings → AI Robot (owners and admins; the server refuses anyone else): automatic WhatsApp
// replies in unassigned chats when nobody from the team answers (server: services/aiRobot.ts). Changes are saved
// together with "Save"; "Test the robot" shows what it would answer in a chat, without saving or sending anything.
export default function AiRobotPage() {
  return (
    <AppShell>
      {(me) => (
        <SettingsShell me={me} section="Company settings" title="AI Robot">
          <AiRobot me={me} />
        </SettingsShell>
      )}
    </AppShell>
  );
}

type Form = Required<{ [K in keyof AiRobotInput]: NonNullable<AiRobotInput[K]> }>;
const EDITABLE: (keyof Form)[] = ['enabled', 'mode', 'firstReplyMins', 'groupSeconds', 'hoursRule', 'maxRepliesPerDay', 'minConfidence', 'webSearch', 'handoverMessage', 'companyInfo', 'bannedPhrases'];
const formOf = (s: AiRobotSettings): Form => ({
  enabled: s.enabled,
  mode: s.mode,
  firstReplyMins: s.firstReplyMins,
  groupSeconds: s.groupSeconds,
  hoursRule: s.hoursRule,
  maxRepliesPerDay: s.maxRepliesPerDay,
  minConfidence: s.minConfidence,
  webSearch: s.webSearch,
  handoverMessage: s.handoverMessage ?? '',
  companyInfo: s.companyInfo ?? '',
  bannedPhrases: s.bannedPhrases ?? '',
});
const CONFIDENCE = [0.5, 0.6, 0.7, 0.8, 0.9];
const LIMITS = { firstReplyMins: [1, 240], groupSeconds: [0, 120], maxRepliesPerDay: [1, 100] } as const;
const input = 'rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15';

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${checked ? 'bg-success' : 'bg-faint/50'}`}
    >
      <span
        style={{ backgroundColor: '#fff', boxShadow: '0 1px 3px rgb(0 0 0 / 0.3)' }}
        className={`inline-block h-5 w-5 rounded-full transition-transform ${checked ? 'translate-x-5' : 'translate-x-0'}`}
      />
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[13px] font-semibold text-ink">{label}</span>
      {hint && <span className="mt-0.5 block text-[12px] text-body-soft">{hint}</span>}
      <span className="mt-2 block">{children}</span>
    </label>
  );
}

function Notice({ tone, children }: { tone: 'warning' | 'danger'; children: React.ReactNode }) {
  return (
    <div
      role="status"
      className={`mt-4 rounded-xl border px-5 py-3 text-[13px] ${tone === 'danger' ? 'border-danger-border bg-danger-soft text-danger' : 'border-warning-border bg-warning-soft text-warning'}`}
    >
      {children}
    </div>
  );
}

function AiRobot({ me }: { me: Me }) {
  const router = useRouter();
  const admin = isAdminRole(me.role);
  const [saved, setSaved] = useState<AiRobotSettings | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!admin) return router.replace('/settings');
    fetchAiRobotSettings()
      .then((s) => {
        setSaved(s);
        setForm(formOf(s));
      })
      .catch((e) => setError((e as Error).message));
  }, [admin, router]);
  if (!admin) return null;
  if (!saved || !form)
    return error ? <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p> : <div className="h-96 max-w-4xl animate-pulse rounded-xl bg-surface-strong" aria-busy="true" />;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f!, [k]: v }));
  const initial = formOf(saved);
  const changed = EDITABLE.filter((k) => form[k] !== initial[k]);
  const numberProblem = (Object.keys(LIMITS) as (keyof typeof LIMITS)[])
    .map((k) => {
      const v = form[k];
      const [min, max] = LIMITS[k];
      return Number.isInteger(v) && v >= min && v <= max ? '' : `${k === 'firstReplyMins' ? 'Auto answer after' : k === 'groupSeconds' ? 'Group quick messages' : 'Max replies per chat per day'}: ${min} to ${max}`;
    })
    .find(Boolean);

  async function save() {
    setBusy(true);
    setError('');
    try {
      const next = await updateAiRobotSettings(Object.fromEntries(changed.map((k) => [k, form![k]])) as AiRobotInput);
      setSaved(next);
      setForm(formOf(next));
      showToast(`ai-robot:${Date.now()}`, '', 'AI Robot settings saved.', me.workspace.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const number = (k: keyof typeof LIMITS) => (
    <input
      type="number"
      min={LIMITS[k][0]}
      max={LIMITS[k][1]}
      value={Number.isNaN(form[k]) ? '' : form[k]}
      onChange={(e) => set(k, e.target.value === '' ? Number.NaN : Math.round(Number(e.target.value)))}
      className={`${input} w-28`}
    />
  );

  return (
    <>
      <div className="max-w-4xl">
        <h2 className="text-xl font-bold text-ink">AI Robot</h2>
        <p className="mt-1 text-[13px] text-body-soft">
          Answers customers in unassigned chats when nobody from the team replies, using ChatGPT, the Tyrescart catalogue and the company information below. It stops in a chat as soon as a
          team member replies, the chat is assigned or snoozed, or someone presses Stop robot.
        </p>

        <section className="mt-5 rounded-xl border border-line bg-surface p-5">
          <span className="flex items-center gap-3 text-[14px] font-medium text-body">
            Turn on the AI Robot
            <Switch checked={form.enabled} onChange={(v) => set('enabled', v)} label="Turn on the AI Robot" />
          </span>
          <p className="mt-2 flex items-center gap-1.5 text-[12px] text-body-soft">
            <span className={`h-2 w-2 rounded-full ${saved.enabled ? (saved.mode === 'live' ? 'bg-success' : 'bg-warning') : 'bg-faint'}`} aria-hidden="true" />
            {saved.enabled ? (saved.mode === 'live' ? 'On: replying to customers' : 'On in draft mode: writing replies in the chat, sending nothing') : 'Off'}
            {saved.updatedAt && <span className="text-faint"> · last changed {formatDateTime(saved.updatedAt)}</span>}
          </p>
        </section>

        {!saved.serverEnabled && <Notice tone="danger">The AI Robot is turned off on this server (AI_ROBOT_ENABLED=false). It won&apos;t run whatever is set here.</Notice>}
        {!saved.aiConfigured && <Notice tone="danger">No AI service is set up on this server (OPENROUTER_API_KEY or ANTHROPIC_API_KEY), so the robot can&apos;t run.</Notice>}
        {!saved.catalogueConfigured && (
          <Notice tone="warning">The Tyrescart catalogue isn&apos;t connected on this server (TYRESCART_GRAPHQL_URL): the robot never quotes prices or stock, and hands those questions to the team.</Notice>
        )}
        {!form.enabled && (
          <Notice tone="warning">
            <span className="font-semibold">The AI Robot is off.</span> <span className="text-body">Your settings below are kept for when you turn it on.</span>
          </Notice>
        )}

        <div inert={!form.enabled} aria-disabled={!form.enabled} className={`transition-opacity ${form.enabled ? '' : 'pointer-events-none select-none opacity-50 grayscale'}`}>
          <section className="mt-5 rounded-xl border border-line bg-surface p-6">
            <h3 className="text-[15px] font-bold text-ink">Mode</h3>
            <div className="mt-3 space-y-3" role="radiogroup" aria-label="Mode">
              {(
                [
                  ['draft', 'Draft', 'Writes its replies into the chat’s AI Robot tab and sends nothing. A team member can send a draft with “Use this reply”. Start here.'],
                  ['live', 'Live', 'Sends its replies to customers on WhatsApp.'],
                ] as const
              ).map(([value, title, text]) => (
                <label key={value} className="flex cursor-pointer items-start gap-3">
                  <input type="radio" name="ai-robot-mode" checked={form.mode === value} onChange={() => set('mode', value)} className="mt-0.5 h-[18px] w-[18px] shrink-0 cursor-pointer accent-primary" />
                  <span>
                    <span className="block text-[14px] font-semibold text-ink">{title}</span>
                    <span className="block text-[13px] text-body-soft">{text}</span>
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section className="mt-5 rounded-xl border border-line bg-surface p-6">
            <h3 className="text-[15px] font-bold text-ink">When it replies</h3>
            <div className="mt-4 grid gap-5 sm:grid-cols-2">
              <Field label="Auto answer after (minutes)" hint="First reply when nobody from the team has answered the customer (1 to 240)">
                {number('firstReplyMins')}
              </Field>
              <Field label="Group quick messages (seconds)" hint="After its first reply: waits this long for more messages, then answers them together (0 = at once)">
                {number('groupSeconds')}
              </Field>
              <Field label="When to run" hint="Working hours are set in Simple automations">
                <select value={form.hoursRule} onChange={(e) => set('hoursRule', e.target.value as Form['hoursRule'])} className={`${input} cursor-pointer`}>
                  <option value="any">Always</option>
                  <option value="in_hours">Only during working hours</option>
                  <option value="out_hours">Only outside working hours</option>
                </select>
              </Field>
              <Field label="Max robot replies per chat per day" hint="Then it hands the chat to the team (1 to 100)">
                {number('maxRepliesPerDay')}
              </Field>
            </div>
          </section>

          <section className="mt-5 rounded-xl border border-line bg-surface p-6">
            <h3 className="text-[15px] font-bold text-ink">What it says</h3>
            <div className="mt-4 space-y-5">
              <Field label="About the company" hint="Facts the robot may use: branches, opening hours, services, fitting, delivery areas, payment options (e.g. Tabby), warranty. It never mentions anything that isn't here or in the catalogue.">
                <textarea value={form.companyInfo} onChange={(e) => set('companyInfo', e.target.value)} rows={7} maxLength={8000} className={`${input} w-full`} />
              </Field>
              <Field label="Handover message" hint="Sent once when the robot passes a chat to the team. Empty: the default (in Arabic for customers who write in Arabic).">
                <textarea value={form.handoverMessage} onChange={(e) => set('handoverMessage', e.target.value)} rows={2} maxLength={1000} placeholder={saved.defaultHandoverMessage} className={`${input} w-full`} />
              </Field>
              <Field label="Banned words and phrases" hint="One per line. A reply containing one is not sent (the chat is handed over instead).">
                <textarea value={form.bannedPhrases} onChange={(e) => set('bannedPhrases', e.target.value)} rows={3} maxLength={4000} placeholder={'guarantee\nfree'} className={`${input} w-full`} />
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Minimum confidence" hint="Replies the AI is less sure about are not sent: the chat is handed over">
                  <select value={form.minConfidence} onChange={(e) => set('minConfidence', Number(e.target.value))} className={`${input} cursor-pointer`}>
                    {[...new Set([...CONFIDENCE, form.minConfidence])]
                      .sort((a, b) => a - b)
                      .map((c) => (
                        <option key={c} value={c}>
                          {Math.round(c * 100)}%{c === 0.7 ? ' (recommended)' : ''}
                        </option>
                      ))}
                  </select>
                </Field>
                <div>
                  <span className="flex items-center gap-3 text-[13px] font-semibold text-ink">
                    Web search for general questions
                    <Switch checked={form.webSearch && saved.webSearchAvailable} onChange={(v) => set('webSearch', v)} label="Web search for general questions" disabled={!saved.webSearchAvailable} />
                  </span>
                  <span className="mt-0.5 block text-[12px] text-body-soft">
                    {saved.webSearchAvailable
                      ? 'Season, comfort, what a speed rating means… Never used for prices or stock: those only come from the Tyrescart catalogue.'
                      : 'Not available on this server (needs OpenRouter).'}
                  </span>
                </div>
              </div>
            </div>
          </section>
        </div>

        <TestRobot disabled={!saved.aiConfigured} unsaved={changed.length > 0} />

        {error && <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
      </div>
      <div className="sticky -bottom-6 z-10 -mx-8 -mb-6 mt-6 flex items-center justify-end gap-3 border-t border-line bg-surface px-8 py-3.5">
        <span className="mr-auto text-[12px] text-muted">{changed.length ? `${changed.length} unsaved ${changed.length === 1 ? 'change' : 'changes'}` : 'All changes saved'}</span>
        <button
          type="button"
          disabled={!changed.length || busy}
          onClick={() => setForm(formOf(saved))}
          className="min-w-24 rounded-lg border border-primary px-5 py-2 text-[13px] font-semibold text-primary hover:bg-primary/5 disabled:border-line disabled:text-faint disabled:hover:bg-transparent"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!changed.length || busy || !!numberProblem}
          title={numberProblem || undefined}
          onClick={save}
          className="min-w-24 rounded-lg bg-primary px-5 py-2 text-[13px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  );
}

// Test the robot: pick a chat, see what it would answer now (and what it looked up). Works whether the robot is on or
// off; uses the SAVED settings. Nothing is saved or sent.
function TestRobot({ disabled, unsaved }: { disabled: boolean; unsaved: boolean }) {
  const [chats, setChats] = useState<AiRobotTestChat[] | null>(null);
  const [chatId, setChatId] = useState('');
  const [result, setResult] = useState<AiRobotTest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    fetchAiRobotTestChats()
      .then((list) => {
        setChats(list);
        setChatId((id) => id || list[0]?.conversationId || '');
      })
      .catch((e) => setError((e as Error).message));
  }, []);
  async function run() {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(await testAiRobot(chatId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const chat = chats?.find((c) => c.conversationId === chatId);
  return (
    <section className="mt-5 rounded-xl border border-line bg-surface p-6">
      <h3 className="text-[15px] font-bold text-ink">Test the robot</h3>
      <p className="mt-1 text-[13px] text-body-soft">
        See what it would answer in a chat right now, and what it looked up. Nothing is saved or sent.{unsaved ? ' Save your changes first to test them.' : ''}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <select value={chatId} onChange={(e) => setChatId(e.target.value)} aria-label="Chat to test" disabled={!chats?.length} className={`${input} min-w-0 max-w-full flex-1 cursor-pointer sm:max-w-md`}>
          {!chats && <option>Loading chats…</option>}
          {chats && !chats.length && <option>No chats with a customer message yet</option>}
          {chats?.map((c) => (
            <option key={c.conversationId} value={c.conversationId}>
              {c.name}: {c.lastCustomerMessage.slice(0, 60) || '(no text)'}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={run}
          disabled={disabled || busy || !chatId}
          className="rounded-lg bg-primary px-5 py-2 text-[13px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
        >
          {busy ? 'Thinking…' : 'Test'}
        </button>
      </div>
      {chat && (chat.assigned || chat.status !== 'open') && (
        <p className="mt-2 text-[12px] text-muted">This chat is {chat.assigned ? 'assigned' : chat.status}: the robot wouldn&apos;t reply in it for real, but you can still test it.</p>
      )}
      {error && <p className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
      {result && (
        <div className="mt-4 rounded-lg border border-line bg-surface-muted p-4 text-[13px]">
          <p className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${result.action === 'reply' ? 'bg-success-soft text-success' : 'bg-warning-soft text-warning'}`}>
              {result.action === 'reply' ? 'Would reply' : result.action === 'order' ? 'Would send the order summary and hand over' : 'Would hand over'}
            </span>
            {result.confidence != null && <span className="text-muted">confidence {Math.round(result.confidence * 100)}%</span>}
          </p>
          <p className="mt-3 whitespace-pre-wrap rounded-lg bg-surface px-3 py-2 text-ink">{result.reply}</p>
          {result.blockedBy && (
            <div className="mt-3">
              <p className="font-semibold text-danger">Stopped by a safety check: {result.blockedBy}</p>
              {result.aiReply && <p className="mt-1 whitespace-pre-wrap text-body-soft">The AI wrote: {result.aiReply}</p>}
            </div>
          )}
          {result.reason && !result.blockedBy && <p className="mt-3 text-body-soft">{result.action === 'order' ? 'Order for the team' : 'Why'}: {result.reason}</p>}
          {result.tools.length > 0 && (
            <ul className="mt-3 space-y-1 text-[12px] text-body-soft">
              {result.tools.map((t, i) => (
                <li key={i}>• {toolText(t.replace(/^(\w+)\((.*)\) → /, '$1 '))}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
