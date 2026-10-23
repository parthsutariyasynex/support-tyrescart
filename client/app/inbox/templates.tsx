'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Message } from '@/lib/inbox';
import { fetchContact } from '@/lib/contacts';
import { type Template, type TemplateValues, autoFillValues, customerNames, fetchApprovedTemplates, missingValues, nameFor, readableMessage, sendTemplate } from '@/lib/templates';
import { CONTACT_UPDATED_EVENT } from './ContactPanel';
import { overLimit } from '@/lib/textLimits';

// Composer button: pick one of the number's approved templates (search by name or text); it opens inline above the
// chat (TemplateComposer) to fill in and send. Templates are the only messages WhatsApp allows once the 24-hour
// window has closed.
export function TemplatePicker({
  disabled,
  highlight,
  onPick,
  variant = 'toolbar',
}: {
  disabled: boolean;
  highlight: boolean;
  onPick: (t: Template) => void;
  // toolbar: beside Reply / Add note; primary: the big "Send template" once the 24-hour window has closed
  variant?: 'toolbar' | 'primary';
}) {
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
      {/* "Template" beside Reply / Add note above the message box; stands out once the 24-hour window has closed */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title={highlight ? '24-hour window closed: send an approved template' : 'Send an approved template'}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={
          variant === 'primary'
            ? 'flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-xs font-semibold text-on-primary shadow-xs transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50'
            : `flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                open || highlight ? 'border-primary/40 bg-primary-subtle text-primary' : 'border-line text-muted hover:bg-surface-muted hover:text-body'
              }`
        }
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5" />
        </svg>
        {variant === 'primary' ? 'Send template' : 'Template'}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Approved templates"
          className={`absolute z-50 flex max-h-[60vh] w-80 ${variant === 'primary' ? 'bottom-11 right-0' : 'bottom-9 left-0'} max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-2xl border border-line bg-surface text-xs shadow-xl`}
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

// The chosen template, inline above the chat: just the message, with {{1}} / {{2}} filled with the customer's first
// and last name from their contact (else their WhatsApp name). No name (a number-only contact): it goes without
// one ("Hello 👋, …", never "{{1}}" or a made-up name; see NO_NAME). Boxes only for other values (an order
// number, a header file). Esc or ✕ cancels; nothing is sent until "Send template" → "Yes, Send".
export function TemplateComposer({
  template: t,
  conversationId,
  customer,
  meName,
  onSent,
  onClose,
}: {
  template: Template;
  conversationId: string;
  customer: { id: string; name: string | null; waId: string };
  meName: string;
  onSent: (m: Message) => void;
  onClose: () => void;
}) {
  const [names, setNames] = useState(() => customerNames({ name: customer.name }));
  const [values, setValues] = useState<TemplateValues>(() => autoFillValues(t, customerNames({ name: customer.name })));
  const touched = useRef(new Set<string>()); // fields the agent typed in: never overwritten by the auto-fill
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // "Send template" asks first: the confirmation (with its own request id) is open; nothing is sent until "Yes, Send"
  const [confirm, setConfirm] = useState<{ requestId: string } | null>(null);
  const [contactVersion, setContactVersion] = useState(0);

  // The saved first / last name (the chat list only has the WhatsApp name); re-fills what the agent hasn't touched
  useEffect(() => {
    let cancelled = false;
    fetchContact(customer.id)
      .then((c) => {
        if (cancelled) return;
        const n = customerNames(c);
        setNames(n);
        const auto = autoFillValues(t, n);
        setValues((v) => {
          const body = { ...v.body };
          for (const k of t.bodyVariables) if (!touched.current.has(`body-${k}`) && nameFor(k)) body[k] = auto.body[k] ?? '';
          return { ...v, body };
        });
      })
      .catch(() => {}); // keeps the WhatsApp-name fill
    return () => {
      cancelled = true;
    };
  }, [customer.id, t, contactVersion]);
  // A name added or changed in the profile (by anyone) shows here at once
  useEffect(() => {
    const on = (e: Event) => (e as CustomEvent<{ id?: string }>).detail?.id === customer.id && setContactVersion((n) => n + 1);
    window.addEventListener(CONTACT_UPDATED_EVENT, on);
    return () => window.removeEventListener(CONTACT_UPDATED_EVENT, on);
  }, [customer.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && !confirm && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, confirm, onClose]);

  const set = (part: keyof TemplateValues, key: string, value: string) => {
    touched.current.add(`${part}-${key}`);
    setValues((v) => ({ ...v, [part]: { ...v[part], [key]: value } }));
  };
  const missing = missingValues(t, values, file);
  const message = [t.header?.format === 'TEXT' ? readableMessage(t.header.text ?? '', values.header) : '', readableMessage(t.body, values.body), t.footer ?? '']
    .filter(Boolean)
    .join('\n\n');
  const quick = [
    names.first ? { label: 'First name', value: names.first } : null,
    names.last ? { label: 'Last name', value: names.last } : null,
    { label: 'Phone', value: `+${customer.waId}` },
    { label: 'My name', value: meName },
  ].filter((x): x is { label: string; value: string } => !!x && !!x.value);

  // "Send template": check everything is filled in, then ask (one request id per confirmation)
  function askToSend() {
    if (missing.length) return setError(`Fill in: ${missing.join(', ')}`);
    if (tooLong.length) return setError(`Too long for WhatsApp: ${tooLong.join(', ')}. Shorten it to send.`);
    setError('');
    setConfirm({ requestId: crypto.randomUUID() });
  }
  // "Yes, Send": the only place a template is sent; ignored while a send is already running
  async function send() {
    if (!confirm || busy) return;
    setBusy(true);
    try {
      onSent(await sendTemplate(conversationId, t, values, file, confirm.requestId));
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setConfirm(null);
      setBusy(false);
    }
  }

  // Values over Meta's limit for that place (header 60, body 1024, …): kept as typed, Send waits (filled while rendering)
  const tooLong: string[] = [];
  const field = (part: keyof TemplateValues, key: string, label: string, hint?: string, maxLength = 1024) => {
    if (part === 'body' && nameFor(key)) return null; // names come only from the contact
    const value = values[part][key] ?? '';
    const over = overLimit(value, maxLength);
    if (over) tooLong.push(label);
    return (
      <div key={`${part}-${key}`}>
        <label htmlFor={`tv-${part}-${key}`} className="mb-1 block text-[11px] font-semibold text-muted">
          {label}
        </label>
        {hint && <p className="mb-1 break-all text-[11px] text-faint">{hint}</p>}
        {over && <p className="mb-1 text-[11px] font-semibold text-danger">{value.length.toLocaleString('en')} / {maxLength.toLocaleString('en')} characters: WhatsApp allows up to {maxLength.toLocaleString('en')} here</p>}
        <input
          id={`tv-${part}-${key}`}
          value={value}
          onChange={(e) => set(part, key, e.target.value)}
          className={`w-full rounded-lg border bg-surface px-3 py-1.5 text-[13px] text-ink outline-hidden focus:border-primary focus:ring-1 focus:ring-primary ${
            !value.trim() ? 'border-warning-border' : 'border-line'
          }`}
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
  };
  const mediaFormat = t.header && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(t.header.format) ? t.header.format : null;

  return (
    <div role="dialog" aria-label="Send template" className="flex max-h-[55vh] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
      <div className="flex items-center justify-between gap-3 border-b border-line-soft px-3.5 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <svg className="h-4 w-4 shrink-0 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5" />
          </svg>
          <span className="truncate font-semibold text-ink">{t.name}</span>
          <span className="shrink-0 rounded bg-surface-strong px-1 text-[10px] text-muted">{t.language}</span>
          <span className="shrink-0 text-[10px] text-faint">{t.category.charAt(0) + t.category.slice(1).toLowerCase()}</span>
        </div>
        <button type="button" onClick={onClose} disabled={busy} aria-label="Cancel template" title="Cancel (Esc)" className="rounded-md px-1.5 py-0.5 text-faint hover:bg-surface-muted hover:text-body">
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3.5">
        <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink" aria-label="Message">
          {message}
        </p>
        <div className="grid gap-3 sm:grid-cols-2 empty:hidden">
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
        </div>
        {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line-soft px-3.5 py-2">
        {missing.length > 0 && <span className="mr-auto text-[11px] text-warning">Still to fill in: {missing.join(', ')}</span>}
        <button type="button" disabled={busy} onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-body-soft hover:bg-surface-muted disabled:opacity-50">
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || missing.length > 0}
          onClick={askToSend}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-semibold text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? 'Sending…' : 'Send template'}
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="m3.4 20.4 17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.993.993 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z" />
          </svg>
        </button>
      </div>
      {confirm &&
        typeof document !== 'undefined' &&
        createPortal(
          <ConfirmTemplateSend template={t} message={message} busy={busy} onYes={send} onCancel={() => !busy && setConfirm(null)} />,
          document.body,
        )}
    </div>
  );
}

// "Send this template?": its name and exactly what the customer will get (read-only, as approved by Meta), then
// Yes, Send or Cancel. Esc, Cancel or a click outside send nothing.
function ConfirmTemplateSend({
  template: t,
  message,
  busy,
  onYes,
  onCancel,
}: {
  template: Template;
  message: string;
  busy: boolean;
  onYes: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-shadow/40 p-4 sm:items-center" onClick={onCancel}>
      <div role="alertdialog" aria-modal="true" aria-label="Send this template?" onClick={(e) => e.stopPropagation()} className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-surface shadow-xl">
        <div className="px-5 pt-5">
          <h2 className="text-sm font-bold text-ink">Send this template?</h2>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
            <span className="font-semibold text-body">{t.name}</span>
            <span className="rounded bg-surface-strong px-1 text-[10px]">{t.language}</span>
            <span className="text-[10px] text-faint">{t.category.charAt(0) + t.category.slice(1).toLowerCase()}</span>
          </p>
        </div>
        <p className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words px-5 py-4 text-[13px] leading-relaxed text-ink" aria-label="Message">
          {message}
        </p>
        <div className="flex justify-end gap-2 border-t border-line-soft px-5 py-3">
          <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel} className="rounded-lg px-3 py-1.5 text-xs font-medium text-body-soft hover:bg-surface-strong disabled:opacity-50">
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={onYes} className="rounded-lg bg-primary px-4 py-1.5 text-xs font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-60">
            {busy ? 'Sending…' : 'Yes, Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
