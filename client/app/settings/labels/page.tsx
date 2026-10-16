'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { type Label, LABEL_COLORS, colorName, createLabel, deleteLabel, fetchLabels, fetchPermissions, filterLabels, pageOf, updateLabel, usedColors } from '@/lib/labels';
import { showToast } from '@/lib/toasts';
import { AppShell } from '../../AppShell';
import { inputClass } from '../../AuthShell';
import { ConfirmDialog } from '../../ConfirmDialog';
import { LabelPill } from '../../inbox/LabelsDropdown';
import { SettingsShell } from '../SettingsShell';
import { TableSkeleton } from '../Skeleton';

// Settings → Contacts and data → Labels: every label of the workspace in a table: search, filter by colour, sort by
// name, pages of 20. Anyone can create a label; renaming, recolouring and deleting (one, or the ticked ones) is for
// supervisors and admins, or anyone granted it. The server checks the same.
export default function LabelsSettingsPage() {
  return (
    <AppShell>
      {(me) => (
        <SettingsShell me={me} section="Contacts and data" title="Labels">
          <Labels />
        </SettingsShell>
      )}
    </AppShell>
  );
}

const PAGE_SIZE = 20;

function Labels() {
  const [labels, setLabels] = useState<Label[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [query, setQuery] = useState('');
  const [color, setColor] = useState('');
  const [sort, setSort] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<{ label: Label | null } | null>(null);
  const [deleting, setDeleting] = useState<Label[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => fetchLabels().then(setLabels).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    load();
    fetchPermissions()
      .then((p) => setCanManage(p.canManageLabels))
      .catch(() => {});
  }, [load]);

  if (!labels) return error ? <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p> : <TableSkeleton rows={8} className="mt-[88px]" />;
  const shown = filterLabels(labels, query, color, sort);
  const { items, page: current, pages } = pageOf(shown, page, PAGE_SIZE);
  const ticked = labels.filter((l) => selected.has(l.id));
  const allOnPage = items.length > 0 && items.every((l) => selected.has(l.id));
  const toggle = (ids: string[], on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
      return next;
    });

  async function remove(list: Label[]) {
    setBusy(true);
    setError('');
    let done = 0;
    try {
      for (const l of list) {
        await deleteLabel(l.id);
        done++;
      }
      showToast(`labels:${Date.now()}`, '', list.length === 1 ? `Label “${list[0].name}” deleted.` : `${list.length} labels deleted.`, 'Labels');
    } catch (e) {
      setError(`${done ? `${done} deleted, then: ` : ''}${(e as Error).message}`);
    } finally {
      setBusy(false);
      setDeleting(null);
      toggle(
        list.map((l) => l.id),
        false,
      );
      load();
    }
  }

  const iconButton = 'flex h-8 w-8 items-center justify-center rounded-lg text-body-soft transition hover:bg-surface-muted hover:text-ink';
  return (
    <div className="max-w-6xl">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex w-full max-w-xs items-center gap-2 rounded-lg border border-line bg-surface px-3 focus-within:border-primary">
          <svg className="h-4 w-4 shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Search labels"
            aria-label="Search labels"
            className="w-full bg-transparent py-2.5 text-[13px] text-ink outline-hidden placeholder:text-faint"
          />
        </div>
        <ColorFilter
          colors={usedColors(labels)}
          value={color}
          onChange={(c) => {
            setColor(c);
            setPage(1);
          }}
        />
        <div className="ml-auto flex items-center gap-2">
          {canManage && ticked.length > 0 && (
            <button type="button" disabled={busy} onClick={() => setDeleting(ticked)} className="rounded-lg border border-danger px-4 py-2 text-[13px] font-semibold text-danger transition hover:bg-danger-soft disabled:opacity-50">
              Delete selected ({ticked.length})
            </button>
          )}
          <button type="button" onClick={() => setEditor({ label: null })} className="rounded-lg bg-primary px-5 py-2.5 text-[13px] font-semibold text-on-primary transition hover:bg-primary-hover">
            Create new label
          </button>
        </div>
      </div>
      <p className="mt-4 text-[13px] text-body">
        Total: {labels.length} {labels.length === 1 ? 'label' : 'labels'}
        {shown.length !== labels.length && <span className="text-muted"> · {shown.length} shown</span>}
        {!canManage && <span className="text-muted"> · Editing and deleting labels is for supervisors and admins.</span>}
      </p>
      {error && <p className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}

      <div className="mt-3 overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full text-left text-[13px]" aria-label="Labels">
          <thead>
            <tr className="border-b border-line bg-surface-muted">
              <th className="w-12 px-4 py-3">
                {canManage && (
                  <input
                    type="checkbox"
                    checked={allOnPage}
                    onChange={(e) =>
                      toggle(
                        items.map((l) => l.id),
                        e.target.checked,
                      )
                    }
                    aria-label="Select all labels on this page"
                    className="h-4 w-4 cursor-pointer accent-primary"
                  />
                )}
              </th>
              <th className="px-2 py-3">
                <button
                  type="button"
                  onClick={() => {
                    setSort((s) => (s === 'asc' ? 'desc' : 'asc'));
                    setPage(1);
                  }}
                  aria-label={`Label name, sorted ${sort === 'asc' ? 'A to Z' : 'Z to A'}`}
                  className="flex items-center gap-1.5 font-semibold text-ink"
                >
                  Label name
                  <svg className="h-4 w-4 text-body-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m7 9 5-5 5 5" className={sort === 'asc' ? 'text-ink' : 'opacity-40'} />
                    <path d="m7 15 5 5 5-5" className={sort === 'desc' ? 'text-ink' : 'opacity-40'} />
                  </svg>
                </button>
              </th>
              <th className="px-2 py-3 font-semibold text-ink">Used in</th>
              <th className="w-28 px-4 py-3" aria-label="Actions" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {items.map((l) => (
              <tr key={l.id} className={`group ${selected.has(l.id) ? 'bg-primary/5' : 'hover:bg-surface-muted/60'}`}>
                <td className="px-4 py-3">
                  {canManage && (
                    <input
                      type="checkbox"
                      checked={selected.has(l.id)}
                      onChange={(e) => toggle([l.id], e.target.checked)}
                      aria-label={`Select ${l.name}`}
                      className="h-4 w-4 cursor-pointer accent-primary"
                    />
                  )}
                </td>
                <td className="px-2 py-3">
                  <LabelPill name={l.name} color={l.color} />
                </td>
                <td className="px-2 py-3 text-body-soft">
                  {l.conversationCount} {l.conversationCount === 1 ? 'chat' : 'chats'}
                </td>
                <td className="px-4 py-3">
                  {canManage && (
                    <span className="flex justify-end gap-1">
                      <button type="button" onClick={() => setEditor({ label: l })} aria-label={`Edit ${l.name}`} title="Edit" className={iconButton}>
                        <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                          <path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z" />
                        </svg>
                      </button>
                      <button type="button" onClick={() => setDeleting([l])} aria-label={`Delete ${l.name}`} title="Delete" className={`${iconButton} hover:text-danger`}>
                        <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
                        </svg>
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {!items.length && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-[13px] text-muted">
                  {labels.length ? 'No labels match.' : 'No labels yet. Create one to tag chats.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-body">
          {items.length}/{shown.length} {shown.length === 1 ? 'label' : 'labels'}
        </p>
        <Pager page={current} pages={pages} onPage={setPage} />
      </div>

      {editor && (
        <LabelEditor
          label={editor.label}
          onClose={() => setEditor(null)}
          onSaved={(message) => {
            setEditor(null);
            load();
            showToast(`labels:${Date.now()}`, '', message, 'Labels');
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={deleting.length === 1 ? `Delete the label “${deleting[0].name}”?` : `Delete ${deleting.length} labels?`}
          body={`${deleting.length === 1 ? 'It is' : 'They are'} removed from every chat. This can't be undone.`}
          yes="Delete"
          danger
          busy={busy}
          onYes={() => remove(deleting)}
          onNo={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

// « ‹ 1 2 3 › »
function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  const btn = 'flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-[13px] transition disabled:cursor-not-allowed disabled:opacity-30';
  const nav = (label: string, to: number, text: string, disabled: boolean) => (
    <button type="button" aria-label={label} disabled={disabled} onClick={() => onPage(to)} className={`${btn} text-body-soft hover:bg-surface-muted`}>
      {text}
    </button>
  );
  return (
    <nav aria-label="Pages" className="flex items-center gap-1">
      {nav('First page', 1, '«', page <= 1)}
      {nav('Previous page', page - 1, '‹', page <= 1)}
      {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onPage(p)}
          aria-current={p === page ? 'page' : undefined}
          className={`${btn} ${p === page ? 'bg-primary font-semibold text-on-primary' : 'text-body hover:bg-surface-muted'}`}
        >
          {p}
        </button>
      ))}
      {nav('Next page', page + 1, '›', page >= pages)}
      {nav('Last page', pages, '»', page >= pages)}
    </nav>
  );
}

// "Label color ⌄": the colours the labels use (with their names), or all
function ColorFilter({ colors, value, onChange }: { colors: string[]; value: string; onChange: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
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
  const choose = (c: string) => {
    onChange(c);
    setOpen(false);
  };
  const option = (c: string, text: string) => (
    <li key={c || 'all'} role="option" aria-selected={value === c}>
      <button
        type="button"
        onClick={() => choose(c)}
        className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] hover:bg-surface-muted ${value === c ? 'font-medium text-primary' : 'text-ink'}`}
      >
        {c ? <span className="h-3.5 w-3.5 shrink-0 rounded-full" style={{ backgroundColor: c }} /> : <span className="h-3.5 w-3.5 shrink-0" />}
        {text}
      </button>
    </li>
  );
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Label color: ${value ? colorName(value) : 'All colours'}`}
        className="flex h-10 min-w-40 items-center gap-2 rounded-full border border-line bg-surface px-4 text-[13px] text-body transition hover:bg-surface-muted"
      >
        {value && <span className="h-3 w-3 rounded-full" style={{ backgroundColor: value }} />}
        <span className="flex-1 text-left">{value ? colorName(value) : 'Label color'}</span>
        <svg className={`h-4 w-4 text-body-soft transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <ul role="listbox" aria-label="Label color" className="absolute left-0 top-full z-30 mt-1.5 max-h-72 w-56 overflow-y-auto rounded-xl border border-line bg-surface py-1 shadow-xl">
          {option('', 'All colours')}
          {colors.map((c) => option(c, colorName(c)))}
        </ul>
      )}
    </div>
  );
}

// Create or edit: name and colour, with a preview of the pill
function LabelEditor({ label, onClose, onSaved }: { label: Label | null; onClose: () => void; onSaved: (message: string) => void }) {
  const [name, setName] = useState(label?.name ?? '');
  const [color, setColor] = useState(label?.color.toLowerCase() ?? LABEL_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return setError('Enter a label name');
    setBusy(true);
    setError('');
    try {
      if (label) await updateLabel(label.id, { name: n, color });
      else await createLabel({ name: n, color });
      onSaved(label ? `Label “${n}” saved.` : `Label “${n}” created.`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form role="dialog" aria-modal="true" aria-labelledby="label-editor-title" onSubmit={save} className="w-full max-w-md rounded-2xl bg-surface p-7 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 id="label-editor-title" className="text-lg font-bold text-ink">
            {label ? 'Edit label' : 'Create new label'}
          </h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-lg text-body-soft hover:bg-surface-muted">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <label htmlFor="label-name" className="mt-5 mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-muted">
          Label name
        </label>
        <input id="label-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={50} placeholder="e.g. VIP" className={inputClass} />
        <p className="mt-5 mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Colour</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Colour">
          {LABEL_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              onClick={() => setColor(c)}
              aria-label={colorName(c)}
              title={colorName(c)}
              className={`h-7 w-7 rounded-full ring-offset-2 ring-offset-surface ${color === c ? 'ring-2 ring-ink' : ''}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
        <p className="mt-5 mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Preview</p>
        <LabelPill name={name.trim() || 'Label name'} color={color} />
        {error && <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
        <div className="mt-7 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-lg px-4 py-2 text-[13px] text-body-soft hover:bg-surface-muted">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="rounded-lg bg-primary px-6 py-2 text-[13px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-60">
            {busy ? 'Saving…' : label ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
