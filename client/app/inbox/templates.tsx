'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Message } from '@/lib/inbox';
import { type Template, type TemplateValues, fetchApprovedTemplates, missingValues, sendTemplate } from '@/lib/templates';
import { TemplatePreview } from '../TemplatePreview';

// Composer button: pick one of the number's approved templates (search by name or text). Templates with values to
// fill in (variables, a header file, a coupon) open the send dialog; templates are the only messages WhatsApp
// allows once the 24-hour window has closed.
export function TemplatePicker({ disabled, highlight, onPick }: { disabled: boolean; highlight: boolean; onPick: (t: Template) => void }) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Loaded fresh each time the menu opens, so newly approved templates show up
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError('');
    setQuery('');
    fetchApprovedTemplates()
      .then((list) => !cancelled && setTemplates(list))
      .catch((err) => !cancelled && setError((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const shown = (templates ?? []).filter((t) => !q || t.name.toLowerCase().includes(q) || t.body.toLowerCase().includes(q));
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title="Send an approved template"
        aria-expanded={open}
        className={`flex h-9 items-center justify-center rounded-xl px-2.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
          open || highlight ? 'bg-primary-subtle text-primary' : 'text-faint hover:bg-surface-strong hover:text-body-soft'
        }`}
      >
        Template
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Approved templates"
          className="absolute bottom-11 left-0 z-50 flex max-h-[60vh] w-80 max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-2xl border border-line bg-surface text-xs shadow-xl"
        >
          <div className="border-b border-line-soft p-2">
            <input
              autoFocus
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search templates"
              aria-label="Search templates"
              className="w-full rounded-lg border border-line bg-surface-muted/60 px-2.5 py-1.5 text-[12px] text-ink outline-hidden focus:border-primary focus:bg-surface"
            />
          </div>
          {error && <div className="m-2 rounded-lg bg-danger-soft px-2.5 py-1.5 text-danger">{error}</div>}
          {!error && !templates && <p className="px-3 py-2 text-muted">Loading…</p>}
          {templates?.length === 0 && <p className="px-3 py-2 text-muted">No approved templates on this number yet. Create one in Settings → Templates.</p>}
          {templates && templates.length > 0 && !shown.length && <p className="px-3 py-2 text-muted">No template matches “{query.trim()}”.</p>}
          <ul className="min-h-0 flex-1 overflow-y-auto py-1">
            {shown.map((t) => (
              <li key={`${t.name}:${t.language}`} className="px-1">
                <button
                  type="button"
                  disabled={!t.sendable}
                  onClick={() => {
                    setOpen(false);
                    onPick(t);
                  }}
                  title={t.unsupportedReason ?? undefined}
                  className="w-full rounded-lg px-2 py-1.5 text-left hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-medium text-body">{t.name}</span>
                    <span className="shrink-0 rounded bg-surface-strong px-1 text-[10px] text-muted">{t.language}</span>
                    <span className="shrink-0 text-[10px] text-faint">{t.category.charAt(0) + t.category.slice(1).toLowerCase()}</span>
                  </span>
                  {t.body && <span className="mt-0.5 line-clamp-2 block text-[11px] text-muted">{t.body}</span>}
                  {!t.sendable && <span className="mt-0.5 block text-[10px] text-faint">{t.unsupportedReason}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const ACCEPT: Record<string, string> = { IMAGE: 'image/jpeg,image/png', VIDEO: 'video/mp4', DOCUMENT: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt' };

// The values a template needs, with a live preview of what the customer gets. Quick fills use the customer's
// details and your name.
export function TemplateSendDialog({
  template: t,
  conversationId,
  customer,
  meName,
  businessName,
  onSent,
  onClose,
}: {
  template: Template;
  conversationId: string;
  customer: { name: string | null; waId: string };
  meName: string;
  businessName?: string;
  onSent: (m: Message) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<TemplateValues>({ header: {}, body: {}, buttons: {} });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const set = (part: keyof TemplateValues, key: string, value: string) => setValues((v) => ({ ...v, [part]: { ...v[part], [key]: value } }));
  const missing = missingValues(t, values, file);
  const firstName = (customer.name ?? '').trim().split(/\s+/)[0] ?? '';
  const quick = [
    customer.name ? { label: 'Customer name', value: customer.name } : null,
    firstName && firstName !== customer.name ? { label: 'First name', value: firstName } : null,
    { label: 'Phone', value: `+${customer.waId}` },
    { label: 'My name', value: meName },
  ].filter((x): x is { label: string; value: string } => !!x && !!x.value);

  async function send() {
    if (missing.length) return setError(`Fill in: ${missing.join(', ')}`);
    setBusy(true);
    setError('');
    try {
      onSent(await sendTemplate(conversationId, t, values, file));
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const field = (part: keyof TemplateValues, key: string, label: string, hint?: string, maxLength = 1024) => (
    <div key={`${part}-${key}`}>
      <label htmlFor={`tv-${part}-${key}`} className="mb-1 block text-[11px] font-semibold text-muted">
        {label}
      </label>
      {hint && <p className="mb-1 break-all text-[11px] text-faint">{hint}</p>}
      <input
        id={`tv-${part}-${key}`}
        value={values[part][key] ?? ''}
        onChange={(e) => set(part, key, e.target.value)}
        maxLength={maxLength}
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-hidden focus:border-primary focus:ring-1 focus:ring-primary"
      />
      {part !== 'buttons' && (
        <div className="mt-1 flex flex-wrap gap-1">
          {quick.map((q) => (
            <button key={q.label} type="button" onClick={() => set(part, key, q.value)} className="rounded-full bg-surface-strong px-2 py-0.5 text-[10px] text-body-soft hover:text-ink">
              {q.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
  const mediaFormat = t.header && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(t.header.format) ? t.header.format : null;

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/50 p-4" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div role="dialog" aria-label="Send template" className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-line-soft px-5 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-bold text-ink">Send template · {t.name}</h2>
            <p className="text-[11px] text-muted">
              {t.category.charAt(0) + t.category.slice(1).toLowerCase()} · {t.language}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="rounded-lg px-2 py-1 text-body-soft hover:bg-surface-muted">
            ✕
          </button>
        </div>
        <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto p-5 md:grid-cols-[1fr_320px]">
          <div className="space-y-4">
            {mediaFormat && (
              <div>
                <p className="mb-1 text-[11px] font-semibold text-muted">Header {mediaFormat.toLowerCase()}</p>
                <input
                  type="file"
                  accept={ACCEPT[mediaFormat]}
                  aria-label={`Header ${mediaFormat.toLowerCase()}`}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="block w-full text-[12px] text-body file:mr-3 file:rounded-lg file:border-0 file:bg-primary-subtle file:px-3 file:py-1.5 file:text-[12px] file:font-semibold file:text-primary"
                />
                <p className="mt-1 text-[11px] text-faint">
                  {mediaFormat === 'IMAGE' ? 'JPEG or PNG, up to 5 MB' : mediaFormat === 'VIDEO' ? 'MP4, up to 16 MB' : 'PDF, Word, Excel, PowerPoint or text, up to 100 MB'}
                </p>
              </div>
            )}
            {t.header?.format === 'TEXT' && t.header.variables.map((v) => field('header', v, `Header {{${v}}}`, undefined, 60))}
            {t.bodyVariables.map((v) => field('body', v, `{{${v}}}`))}
            {t.buttons.map((b, i) =>
              b.type === 'URL' && b.variables.length
                ? field('buttons', String(i), `Link for “${b.text}”`, `${(b.url ?? '').replace(/\{\{.*?\}\}/, '…')} (the part for …)`, 2000)
                : b.type === 'COPY_CODE'
                  ? field('buttons', String(i), 'Coupon code', 'Shown with the “Copy code” button', 15)
                  : null,
            )}
            {!t.needsParameters && <p className="text-[13px] text-body-soft">This template has nothing to fill in. Check the preview and send.</p>}
            {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
          </div>
          <TemplatePreview
            headerFormat={t.header?.format}
            headerText={t.header?.text}
            headerValues={values.header}
            headerFile={file}
            body={t.body}
            bodyValues={values.body}
            footer={t.footer}
            buttons={t.buttons}
            businessName={businessName}
          />
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line-soft px-5 py-3">
          {missing.length > 0 && <span className="mr-auto text-[11px] text-faint">Still to fill in: {missing.join(', ')}</span>}
          <button type="button" disabled={busy} onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-body-soft hover:bg-surface-muted disabled:opacity-50">
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={send} className="rounded-lg bg-primary px-5 py-1.5 text-xs font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-60">
            {busy ? 'Sending…' : 'Send template'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
