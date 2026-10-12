'use client';

import { useEffect, useRef, useState } from 'react';
import { type MessageTemplate, fetchMessageTemplates } from '@/lib/inbox';

// Composer button: pick one of the number's approved templates and send it in the language it was approved in.
// Templates are the only thing WhatsApp allows once the 24-hour window has closed.
export function TemplatePicker({
  disabled,
  highlight,
  onPick,
}: {
  disabled: boolean;
  highlight: boolean;
  onPick: (t: MessageTemplate) => void;
}) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<MessageTemplate[] | null>(null);
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
    fetchMessageTemplates()
      .then((list) => !cancelled && setTemplates(list))
      .catch((err) => !cancelled && setError((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title="Send an approved template"
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
          className="absolute bottom-11 left-0 z-50 flex max-h-[60vh] w-72 max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-2xl border border-line bg-surface text-xs shadow-xl"
        >
          <div className="border-b border-line-soft px-3 py-2 font-semibold text-ink">Approved templates</div>
          {error && <div className="m-2 rounded-lg bg-danger-soft px-2.5 py-1.5 text-danger">{error}</div>}
          {!error && !templates && <p className="px-3 py-2 text-muted">Loading…</p>}
          {templates?.length === 0 && <p className="px-3 py-2 text-muted">No approved templates on this number yet.</p>}
          <ul className="min-h-0 flex-1 overflow-y-auto py-1">
            {templates?.map((t) => (
              <li key={`${t.name}:${t.language}`} className="px-1">
                <button
                  type="button"
                  disabled={t.needsParameters}
                  onClick={() => {
                    setOpen(false);
                    onPick(t);
                  }}
                  title={t.needsParameters ? "This template has variables, which can't be filled in here yet" : undefined}
                  className="w-full rounded-lg px-2 py-1.5 text-left hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-medium text-body">{t.name}</span>
                    <span className="shrink-0 rounded bg-surface-strong px-1 text-[10px] text-muted">{t.language}</span>
                    {t.needsParameters && <span className="shrink-0 text-[10px] text-faint">needs variables</span>}
                  </span>
                  {t.body && <span className="mt-0.5 line-clamp-2 block text-[11px] text-muted">{t.body}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
