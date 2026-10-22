'use client';

import { useEffect, useRef, useState } from 'react';
import {
  type ButtonSpec,
  type Template,
  type TemplateSpec,
  EMPTY_SPEC,
  createTemplate,
  fetchEditorInfo,
  nextVariable,
  specOf,
  templateName,
  updateTemplate,
  variablesOf,
} from '@/lib/templates';
import { inputClass } from '../../AuthShell';
import { TemplatePreview } from '../../TemplatePreview';

// Create or edit a WhatsApp template, with a live preview of what the customer gets. Meta's rules are explained
// and checked as you go (the server checks them again, and Meta reviews the template). Editing keeps the name and
// language; Meta reviews the changed template again.
const CATEGORIES: { value: TemplateSpec['category']; title: string; text: string }[] = [
  { value: 'MARKETING', title: 'Marketing', text: 'Offers, promotions, news and invitations.' },
  { value: 'UTILITY', title: 'Utility', text: 'Updates about an order, booking, delivery or account.' },
  { value: 'AUTHENTICATION', title: 'Authentication', text: 'One-time codes to sign in or verify.' },
];
const HEADER_OPTIONS = [
  { value: '', label: 'None' },
  { value: 'TEXT', label: 'Text' },
  { value: 'IMAGE', label: 'Image' },
  { value: 'VIDEO', label: 'Video' },
  { value: 'DOCUMENT', label: 'Document' },
] as const;
const ACCEPT: Record<string, string> = { IMAGE: 'image/jpeg,image/png', VIDEO: 'video/mp4', DOCUMENT: '.pdf' };
const BUTTON_LIMITS: Record<ButtonSpec['type'], number> = { QUICK_REPLY: 10, URL: 2, PHONE_NUMBER: 1, COPY_CODE: 1 };
const BUTTON_LABEL: Record<ButtonSpec['type'], string> = { QUICK_REPLY: 'Quick reply', URL: 'Visit website', PHONE_NUMBER: 'Call phone number', COPY_CODE: 'Copy offer code' };

export function TemplateEditor({
  template,
  businessName,
  onClose,
  onSaved,
}: {
  template: Template | null;
  businessName: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const editing = !!template;
  const [spec, setSpec] = useState<TemplateSpec>(template ? specOf(template) : EMPTY_SPEC);
  const [file, setFile] = useState<File | null>(null);
  const [languages, setLanguages] = useState<{ value: string; label: string }[]>([]);
  const [mediaAvailable, setMediaAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    fetchEditorInfo()
      .then((i) => {
        setLanguages(i.languages);
        setMediaAvailable(i.mediaHeaderAvailable);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && !busy && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const set = <K extends keyof TemplateSpec>(k: K, v: TemplateSpec[K]) => setSpec((s) => ({ ...s, [k]: v }));
  const auth = spec.category === 'AUTHENTICATION';
  const bodyVars = variablesOf(spec.body);
  const headerVars = spec.header?.format === 'TEXT' ? variablesOf(spec.header.text) : [];
  const count = (type: ButtonSpec['type']) => spec.buttons.filter((b) => b.type === type).length;

  function addVariable() {
    const v = nextVariable(spec.body);
    const el = bodyRef.current;
    const at = el ? el.selectionStart : spec.body.length;
    const body = spec.body.slice(0, at) + v + spec.body.slice(at);
    setSpec((s) => ({ ...s, body, bodyExamples: [...s.bodyExamples, ''] }));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + v.length, at + v.length);
    });
  }
  function addButton(type: ButtonSpec['type']) {
    const b: ButtonSpec =
      type === 'QUICK_REPLY'
        ? { type, text: '' }
        : type === 'URL'
          ? { type, text: '', url: 'https://', example: '' }
          : type === 'PHONE_NUMBER'
            ? { type, text: '', phoneNumber: '' }
            : { type, example: '' };
    set('buttons', [...spec.buttons, b]);
  }
  const updateButton = (i: number, patch: Partial<ButtonSpec>) => set('buttons', spec.buttons.map((b, j) => (j === i ? ({ ...b, ...patch } as ButtonSpec) : b)));

  async function save() {
    setBusy(true);
    setError('');
    try {
      if (template) {
        await updateTemplate(template.id, spec, file);
        onSaved(`“${spec.name}” sent to Meta for review again.`);
      } else {
        const created = await createTemplate(spec, file);
        onSaved(`“${spec.name}” submitted to Meta (${created.status.toLowerCase()}).`);
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const fieldLabel = 'mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-muted';
  const hint = 'mt-1 text-[11px] text-faint';
  const authBody = `{{1}} is your verification code.${spec.securityRecommendation ? ' For your security, do not share this code.' : ''}`;

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={editing ? 'Edit template' : 'Create template'} className="flex w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="text-lg font-bold text-ink">{editing ? `Edit template · ${template!.name}` : 'Create template'}</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="rounded-lg px-2 py-1 text-lg text-body-soft hover:bg-surface-muted">
            ✕
          </button>
        </div>
        <div className="grid min-h-0 flex-1 overflow-hidden md:grid-cols-[1fr_380px]">
          <div className="min-h-0 space-y-6 overflow-y-auto p-6" style={{ scrollbarGutter: 'stable' }}>
            <section>
              <p className={fieldLabel}>Category</p>
              <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Category">
                {CATEGORIES.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    role="radio"
                    aria-checked={spec.category === c.value}
                    disabled={editing && template!.status === 'APPROVED'}
                    onClick={() => set('category', c.value)}
                    className={`rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${spec.category === c.value ? 'border-primary bg-primary/5' : 'border-line hover:bg-surface-muted'}`}
                  >
                    <p className="text-[13px] font-semibold text-ink">{c.title}</p>
                    <p className="mt-0.5 text-[11px] text-muted">{c.text}</p>
                  </button>
                ))}
              </div>
              {editing && template!.status === 'APPROVED' && <p className={hint}>An approved template keeps its category.</p>}
            </section>

            <section className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="tpl-name" className={fieldLabel}>
                  Name
                </label>
                <input id="tpl-name" value={spec.name} disabled={editing} onChange={(e) => set('name', templateName(e.target.value))} placeholder="order_ready" className={`${inputClass} font-mono !text-[13px]`} />
                <p className={hint}>Lowercase letters, numbers and underscores.{editing ? " Can't be changed." : ''}</p>
              </div>
              <div>
                <label htmlFor="tpl-language" className={fieldLabel}>
                  Language
                </label>
                <select id="tpl-language" value={spec.language} disabled={editing} onChange={(e) => set('language', e.target.value)} className={`${inputClass} cursor-pointer`}>
                  {!languages.some((l) => l.value === spec.language) && <option value={spec.language}>{spec.language}</option>}
                  {languages.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label} ({l.value})
                    </option>
                  ))}
                </select>
                <p className={hint}>Each language is its own template.</p>
              </div>
            </section>

            {auth ? (
              <section className="space-y-3 rounded-xl border border-line p-4">
                <p className="text-[13px] text-body">Meta writes the text of code templates. Choose its options:</p>
                <label className="flex items-center gap-2 text-[13px] text-body">
                  <input type="checkbox" checked={spec.securityRecommendation} onChange={(e) => set('securityRecommendation', e.target.checked)} className="h-4 w-4 accent-primary" />
                  Add “For your security, do not share this code.”
                </label>
                <label className="flex items-center gap-2 text-[13px] text-body">
                  <input
                    type="checkbox"
                    checked={spec.codeExpirationMinutes !== null}
                    onChange={(e) => set('codeExpirationMinutes', e.target.checked ? 10 : null)}
                    className="h-4 w-4 accent-primary"
                  />
                  Say when the code expires, after
                  <input
                    type="number"
                    min={1}
                    max={90}
                    disabled={spec.codeExpirationMinutes === null}
                    value={spec.codeExpirationMinutes ?? 10}
                    onChange={(e) => set('codeExpirationMinutes', Math.max(1, Math.min(90, Number(e.target.value) || 1)))}
                    aria-label="Code expires after (minutes)"
                    className="w-16 rounded-md border border-line px-2 py-1 text-[13px] disabled:opacity-50"
                  />
                  minutes
                </label>
              </section>
            ) : (
              <>
       

                <section>
                  <div className="mb-1.5 flex items-center justify-between">
                    <label htmlFor="tpl-body" className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                      Body
                    </label>
                    <button type="button" onClick={addVariable} className="rounded-md px-2 py-0.5 text-[12px] font-semibold text-primary hover:bg-primary/5">
                      + Add variable
                    </button>
                  </div>
                  <textarea
                    id="tpl-body"
                    ref={bodyRef}
                    value={spec.body}
                    onChange={(e) => set('body', e.target.value)}
                    maxLength={1024}
                    rows={6}
                    placeholder="Hi {{1}}, your order {{2}} is ready for fitting at our Al Quoz branch."
                    className={`${inputClass} resize-y`}
                  />
                  <p className={`${hint} flex justify-between`}>
                    <span>Variables are filled in when sending: {'{{1}}'}, {'{{2}}'}… in order. The text can't start or end with one.</span>
                    <span className="tabular-nums">{spec.body.length}/1024</span>
                  </p>
                  {bodyVars.length > 0 && (
                    <div className="mt-3 rounded-xl bg-surface-muted p-3">
                      <p className="mb-2 text-[11px] font-semibold text-muted">Sample values (for Meta's review)</p>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {bodyVars.map((v, i) => (
                          <input
                            key={v}
                            value={spec.bodyExamples[i] ?? ''}
                            onChange={(e) => {
                              const next = [...spec.bodyExamples];
                              next[i] = e.target.value;
                              set('bodyExamples', next);
                            }}
                            placeholder={`{{${v}}} e.g. ${i === 0 ? 'Amir' : 'TC-1042'}`}
                            aria-label={`Sample for {{${v}}}`}
                            className={inputClass}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </section>
              </>
            )}
            {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
          </div>
          <aside className="min-h-0 overflow-y-auto border-l border-line bg-surface-muted/50 p-6">
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted">Preview</p>
            <TemplatePreview
              headerFormat={auth ? null : spec.header?.format}
              headerText={spec.header?.text}
              headerValues={headerVars.length ? { [headerVars[0]]: spec.header?.example ?? '' } : {}}
              headerFile={file}
              body={auth ? authBody : spec.body}
              bodyValues={auth ? { '1': '123456' } : Object.fromEntries(bodyVars.map((v, i) => [v, spec.bodyExamples[i] ?? '']))}
              footer={auth ? (spec.codeExpirationMinutes ? `This code expires in ${spec.codeExpirationMinutes} minutes.` : null) : spec.footer}
              buttons={auth ? [{ type: 'OTP', text: 'Copy code' }] : spec.buttons.map((b) => ({ type: b.type, text: b.type === 'COPY_CODE' ? 'Copy offer code' : b.text }))}
              businessName={businessName}
            />
            <p className="mt-3 text-[11px] text-faint">Variables show your sample values; when you send the template you fill in the real ones.</p>
          </aside>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-6 py-3">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-lg px-4 py-2 text-[13px] text-body-soft hover:bg-surface-muted">
            Cancel
          </button>
          <button type="button" onClick={save} disabled={busy || !spec.name} className="rounded-lg bg-primary px-6 py-2 text-[13px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-60">
            {busy ? 'Submitting…' : editing ? 'Submit changes' : 'Submit for review'}
          </button>
        </div>
      </div>
    </div>
  );
}
