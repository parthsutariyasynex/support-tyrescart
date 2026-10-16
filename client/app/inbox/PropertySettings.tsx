'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { type PropertyView, orderKeys } from '@/lib/contacts';

// "Manage column settings": choose which Contact properties you see and in what order. Saving makes it your
// personal view (only you see it). "Reset to default" goes back to the workspace's default view.
export function PropertySettings({
  fields,
  view,
  onSave,
  onClose,
}: {
  fields: { key: string; label: string }[]; // every property, standard order
  view: PropertyView;
  onSave: (view: Pick<PropertyView, 'personal' | 'order' | 'hidden'>) => Promise<void>;
  onClose: () => void;
}) {
  const all = fields.map((f) => f.key);
  const [order, setOrder] = useState(() => orderKeys(all, view.personal ? view.order : (view.defaultOrder ?? [])));
  const [hidden, setHidden] = useState<string[]>(() => (view.personal ? view.hidden : (view.defaultHidden ?? [])).filter((k) => all.includes(k)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const labelOf = (k: string) => fields.find((f) => f.key === k)?.label ?? k;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const move = (i: number, by: -1 | 1) =>
    setOrder((o) => {
      const j = i + by;
      if (j < 0 || j >= o.length) return o;
      const next = [...o];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const visibleCount = order.length - hidden.length;

  async function save(next: Pick<PropertyView, 'personal' | 'order' | 'hidden'>) {
    setBusy(true);
    setError('');
    try {
      await onSave(next);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Manage column settings" className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl">
        <div className="border-b border-line-soft px-5 py-4">
          <h2 className="text-sm font-bold text-ink">Manage column settings</h2>
          <p className="mt-1 text-xs text-muted">Choose which contact properties you see and their order. This is your personal view; nobody else&apos;s panel changes.</p>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {order.map((k, i) => {
            const shown = !hidden.includes(k);
            return (
              <li key={k} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-muted">
                <input
                  type="checkbox"
                  checked={shown}
                  onChange={() => setHidden((h) => (shown ? [...h, k] : h.filter((x) => x !== k)))}
                  aria-label={`Show ${labelOf(k)}`}
                  className="h-4 w-4 shrink-0 cursor-pointer rounded border-line-strong accent-primary"
                />
                <span className={`min-w-0 flex-1 truncate text-[13px] ${shown ? 'text-ink' : 'text-faint line-through'}`}>{labelOf(k)}</span>
                <button type="button" disabled={i === 0} onClick={() => move(i, -1)} title={`Move ${labelOf(k)} up`} aria-label={`Move ${labelOf(k)} up`} className="rounded-md p-1 text-body-soft hover:bg-surface-strong disabled:opacity-30">
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m18 15-6-6-6 6" />
                  </svg>
                </button>
                <button type="button" disabled={i === order.length - 1} onClick={() => move(i, 1)} title={`Move ${labelOf(k)} down`} aria-label={`Move ${labelOf(k)} down`} className="rounded-md p-1 text-body-soft hover:bg-surface-strong disabled:opacity-30">
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
              </li>
            );
          })}
        </ul>
        {error && <p className="mx-5 mb-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
        <div className="flex items-center justify-between gap-2 border-t border-line-soft px-5 py-3">
          <button type="button" disabled={busy} onClick={() => save({ personal: false, order: [], hidden: [] })} className="rounded-lg px-2 py-1.5 text-xs font-medium text-body-soft hover:bg-surface-muted disabled:opacity-50">
            Reset to default
          </button>
          <div className="flex items-center gap-2">
            {visibleCount === 0 && <span className="text-[11px] text-danger">Show at least one</span>}
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-body-soft hover:bg-surface-muted">
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || visibleCount === 0}
              onClick={() => save({ personal: true, order, hidden })}
              className="rounded-lg bg-primary px-4 py-1.5 text-xs font-semibold text-on-primary hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
