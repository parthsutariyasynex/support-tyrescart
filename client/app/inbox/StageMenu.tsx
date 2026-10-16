'use client';

import { useEffect, useRef, useState } from 'react';
import { type ContactFieldOptions, type ContactOption, type ContactProfile, type StagesChanged, LEAD_STAGES_EVENT, fetchContactFieldOptions, nextStage, updateContact } from '@/lib/contacts';
import { showToast } from '@/lib/toasts';

// The workspace's stages changed (Settings → Customer lifecycle, here or by an admin anywhere)
export function useStagesChanged(onChange: (detail: StagesChanged) => void) {
  const ref = useRef(onChange);
  ref.current = onChange;
  useEffect(() => {
    const on = (e: Event) => ref.current((e as CustomEvent<StagesChanged>).detail ?? {});
    window.addEventListener(LEAD_STAGES_EVENT, on);
    return () => window.removeEventListener(LEAD_STAGES_EVENT, on);
  }, []);
}

const Swatch = ({ color }: { color?: string | null }) => (
  <span className="h-3 w-3 shrink-0 rounded-[3px]" style={{ backgroundColor: color ?? 'var(--color-line)' }} aria-hidden="true" />
);

// Chat header "Select stage": the customer's lead stage, changed in one click. Progressing stages, then the Lost
// ones; the stages and their colours are the workspace's (Settings → Customer lifecycle) and follow changes live. Saving updates the profile everywhere (live).
export function StageMenu({
  contactId,
  value,
  conversationId,
  contactName,
  onSaved,
}: {
  contactId: string;
  value: string | null | undefined;
  conversationId: string;
  contactName: string;
  onSaved: (contact: ContactProfile) => void;
}) {
  const [options, setOptions] = useState<ContactFieldOptions | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchContactFieldOptions().then(setOptions).catch(() => {});
  }, []);
  useStagesChanged(() => fetchContactFieldOptions(true).then(setOptions).catch(() => {}));
  useEffect(() => {
    setOpen(false);
    setError('');
  }, [contactId]);
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

  const stages = options?.leadStages ?? [];
  const current = stages.find((s) => s.value === value);
  const next = nextStage(stages, value);

  async function choose(stage: ContactOption | null) {
    if (busy) return;
    if ((stage?.value ?? null) === (value ?? null)) return setOpen(false);
    setBusy(true);
    setError('');
    try {
      const c = await updateContact(contactId, { leadStage: stage?.value ?? '' });
      onSaved(c);
      setOpen(false);
      showToast(`stage:${contactId}:${Date.now()}`, conversationId, stage ? `Lead stage: ${stage.label}.` : 'Lead stage cleared.', contactName);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const item = (s: ContactOption) => {
    const selected = s.value === value;
    return (
      <li key={s.value} role="option" aria-selected={selected}>
        <button
          type="button"
          disabled={busy}
          onClick={() => choose(s)}
          className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] transition hover:bg-surface-muted disabled:opacity-60 ${selected ? 'text-primary' : 'text-ink'}`}
        >
          <Swatch color={s.color} />
          <span className="flex-1">{s.label}</span>
          {selected && (
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          )}
        </button>
      </li>
    );
  };
  const groupLabel = (text: string) => <li className="px-3.5 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wide text-faint">{text}</li>;

  return (
    <div ref={ref} className="relative flex shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Lead stage"
        title="Lead stage"
        className="flex h-8 min-w-32 items-center gap-2 rounded-l-lg border border-line bg-surface px-2.5 text-xs text-body transition hover:bg-surface-muted"
      >
        {current ? <Swatch color={current.color} /> : null}
        <span className={`max-w-28 flex-1 truncate text-left ${current ? 'font-medium text-ink' : 'text-muted'}`}>{current?.label ?? 'Select stage'}</span>
        <svg className={`h-3.5 w-3.5 text-body-soft transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {/* Next stage in one click (New → Contacted → … → Won); nothing after a closed stage */}
      <button
        type="button"
        onClick={() => next && choose(next)}
        disabled={!next || busy}
        title={next ? `Move to ${next.label}` : current ? (current.closed ? `${current.label} is a lost stage` : `${current.label} is the last stage`) : 'Next stage'}
        aria-label={next ? `Move to ${next.label}` : 'Next stage'}
        className="-ml-px flex h-8 w-8 items-center justify-center rounded-r-lg border border-line bg-surface text-primary transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:text-faint disabled:hover:bg-surface"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1.5 w-56 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-xl">
          <ul role="listbox" aria-label="Lead stage">
            {groupLabel('Progressing stages')}
            {stages.filter((s) => !s.closed).map(item)}
            {stages.some((s) => s.closed) && groupLabel('Lost stages')}
            {stages.filter((s) => s.closed).map(item)}
            {!stages.length && <li className="px-3.5 py-3 text-xs text-faint">Loading…</li>}
          </ul>
          {error && <p className="mx-3 my-1.5 rounded-lg bg-danger-soft px-2.5 py-1.5 text-xs text-danger">{error}</p>}
          {value && (
            <div className="mt-1 border-t border-line-soft pt-1">
              <button type="button" disabled={busy} onClick={() => choose(null)} className="block w-full px-3.5 py-2 text-left text-[13px] text-body-soft hover:bg-surface-muted disabled:opacity-60">
                Clear stage
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The lead stage as a solid pill in the chat list (e.g. an orange "Contacted"); nothing when there's no stage
let stagesCache: ContactOption[] | null = null;
export function StagePill({ value }: { value: string | null | undefined }) {
  const [stages, setStages] = useState<ContactOption[] | null>(stagesCache);
  const load = (fresh: boolean) =>
    fetchContactFieldOptions(fresh)
      .then((o) => {
        stagesCache = o.leadStages;
        setStages(o.leadStages);
      })
      .catch(() => {});
  useEffect(() => {
    if (stagesCache) setStages(stagesCache);
    else load(false);
  }, []);
  useStagesChanged(() => {
    stagesCache = null;
    load(true);
  });
  const stage = value ? stages?.find((s) => s.value === value) : null;
  if (!stage) return null;
  return (
    <span title={`Lead stage: ${stage.label}`} className="inline-flex shrink-0 items-center rounded-md px-1.5 py-px text-[10px] font-semibold text-white" style={{ backgroundColor: stage.color ?? '#64748b' }}>
      {stage.label}
    </span>
  );
}
