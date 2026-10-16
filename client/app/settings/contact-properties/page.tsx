'use client';

import { useEffect, useState } from 'react';
import {
  type ContactOption,
  type ContactProfile,
  type CustomProperty,
  type PropertyView,
  type PropertyRow,
  CUSTOM_PROPERTIES_EVENT,
  createCustomProperty,
  customRows,
  deleteCustomProperty,
  fetchCustomProperties,
  fetchCustomPropertyTypes,
  fetchPropertyView,
  orderKeys,
  propertyKey,
  propertyRows,
  propertyTypeLabel,
  renameStandardProperty,
  saveDefaultPropertyView,
  savePropertyView,
  updateCustomProperty,
  withLabels,
  CHOICE_FIELDS,
  type ChoiceField,
  fetchContactFieldOptions,
  fetchFieldChoiceCounts,
  saveFieldChoices,
} from '@/lib/contacts';
import { isAdminRole } from '@/lib/roles';
import { showToast } from '@/lib/toasts';
import { AppShell } from '../../AppShell';
import { inputClass } from '../../AuthShell';
import { ConfirmDialog } from '../../ConfirmDialog';
import { SearchSelect } from '../../SearchSelect';
import { SettingsShell } from '../SettingsShell';
import { TableSkeleton } from '../Skeleton';

// Settings → Contacts and data → Contact properties ("Manage properties"). Default view: the workspace's order of
// the contact properties and which are shown, set by admins, for everyone's profile panel (Inbox and Contacts).
// Personal view: your own order and shown properties instead, if you switch it on (also from ⋮ in the panel).
// Admins also add columns (custom properties every contact gets), rename any property, and remove added ones.
export default function ContactPropertiesPage() {
  return (
    <AppShell>
      {(me) => (
        <SettingsShell me={me} section="Contacts and data" title="Manage properties">
          <Manage isAdmin={isAdminRole(me.role)} />
        </SettingsShell>
      )}
    </AppShell>
  );
}

// An empty profile, only to list the properties in the panel's standard order
const EMPTY: ContactProfile = {
  id: '', waId: '', name: null, firstName: null, lastName: null, email: null, companyName: null, jobTitle: null, leadStage: null, leadSource: null, priority: null,
  country: null, phoneCountry: null, subscribed: true, waBsuid: null, waUsername: null, lists: [], conversationId: null, createdAt: '', updatedAt: '',
};

type Tab = 'default' | 'personal';
function Manage({ isAdmin }: { isAdmin: boolean }) {
  const [tab, setTab] = useState<Tab>('default');
  const [view, setView] = useState<PropertyView | null>(null);
  const [error, setError] = useState('');
  const [custom, setCustom] = useState<CustomProperty[] | null>(null);
  const [types, setTypes] = useState<ContactOption[]>([]);
  const [modal, setModal] = useState<{ mode: 'create' } | { mode: 'edit'; row: PropertyRow } | null>(null);
  const [removing, setRemoving] = useState<PropertyRow | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tab') === 'personal') setTab('personal');
    const load = (fresh: boolean) => {
      fetchPropertyView()
        .then(setView)
        .catch((e) => setError((e as Error).message));
      fetchCustomProperties(fresh)
        .then(setCustom)
        .catch((e) => setError((e as Error).message));
    };
    load(false);
    fetchCustomPropertyTypes()
      .then(setTypes)
      .catch(() => {});
    const onChanged = () => load(true);
    window.addEventListener(CUSTOM_PROPERTIES_EVENT, onChanged);
    return () => window.removeEventListener(CUSTOM_PROPERTIES_EVENT, onChanged);
  }, []);
  const rows = [...withLabels(propertyRows(EMPTY, null, null), view?.labels), ...customRows(EMPTY, custom ?? [])];
  const all = rows.map((r) => r.key);

  async function remove() {
    if (!removing?.custom) return;
    setRemoveBusy(true);
    try {
      await deleteCustomProperty(removing.custom.id);
      showToast(`prop:${Date.now()}`, '', `“${removing.label}” removed.`, 'Contact properties');
      setRemoving(null);
    } catch (e) {
      setError((e as Error).message);
      setRemoving(null);
    } finally {
      setRemoveBusy(false);
    }
  }

  return (
    <div className="max-w-6xl">
      <div role="tablist" aria-label="Property views" className="flex gap-1 border-b border-line">
        {(['default', 'personal'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-4 py-3 text-[13px] font-semibold transition ${tab === t ? 'border-primary text-primary' : 'border-transparent text-body-soft hover:text-body'}`}
          >
            {t === 'default' ? 'Default view' : 'Personal view'}
          </button>
        ))}
      </div>
      {error && <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
      {!view || !custom ? (
        !error && <TableSkeleton rows={10} className="mt-14" />
      ) : tab === 'default' ? (
        <>
          <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
            <p className="max-w-3xl text-[13px] text-body-soft">
              Columns can be added, removed, reordered, renamed and hidden. The order applies to everyone&apos;s contact profile in the Inbox and on contact pages,
              unless they use a personal view.
              {!isAdmin && ' Only admins can change the default view.'}
            </p>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setModal({ mode: 'create' })}
                className="shrink-0 rounded-lg border border-primary px-5 py-2 text-[13px] font-semibold text-primary transition hover:bg-primary/5"
              >
                Add column
              </button>
            )}
          </div>
          <ViewTable
            rows={rows}
            types={types}
            order={orderKeys(all, view.defaultOrder)}
            hidden={view.defaultHidden}
            editable={isAdmin}
            label="Default view"
            onSave={async (order, hidden) => setView(await saveDefaultPropertyView({ order, hidden }))}
            onEditRow={isAdmin ? (row) => setModal({ mode: 'edit', row }) : undefined}
            onRemoveRow={isAdmin ? setRemoving : undefined}
          />
        </>
      ) : (
        <Personal rows={rows} types={types} all={all} view={view} onSaved={setView} />
      )}
      {modal && (
        <PropertyModal
          key={modal.mode === 'edit' ? modal.row.key : 'new'}
          mode={modal.mode}
          row={modal.mode === 'edit' ? modal.row : null}
          property={modal.mode === 'edit' && modal.row.custom ? (custom?.find((c) => c.id === modal.row.custom!.id) ?? null) : null}
          types={types}
          onSavedView={setView}
          onClose={() => setModal(null)}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove “${removing.label}”?`}
          body="The column and its value on every contact are deleted. This can't be undone."
          yes="Remove"
          danger
          busy={removeBusy}
          onYes={remove}
          onNo={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

function Personal({ rows, types, all, view, onSaved }: { rows: PropertyRow[]; types: ContactOption[]; all: string[]; view: PropertyView; onSaved: (v: PropertyView) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(next: Pick<PropertyView, 'personal' | 'order' | 'hidden'>) {
    setBusy(true);
    setError('');
    try {
      onSaved(await savePropertyView(next));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  // Switching it on starts from the default view
  const fromDefault = { order: orderKeys(all, view.defaultOrder), hidden: view.defaultHidden };
  return (
    <>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-body-soft">Your own order and shown properties, only for you. Nobody else&apos;s view changes.</p>
        <label className="flex items-center gap-2.5 text-[13px] font-medium text-ink">
          Use my personal view
          <Switch
            checked={view.personal}
            disabled={busy}
            label="Use my personal view"
            onChange={(on) => save(on ? { personal: true, ...(view.order.length || view.hidden.length ? { order: view.order, hidden: view.hidden } : fromDefault) } : { personal: false, order: view.order, hidden: view.hidden })}
          />
        </label>
      </div>
      {error && <p className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
      {view.personal ? (
        <>
          <ViewTable rows={rows} types={types} order={orderKeys(all, view.order)} hidden={view.hidden} editable label="Personal view" onSave={(order, hidden) => save({ personal: true, order, hidden })} />
          <button type="button" disabled={busy} onClick={() => save({ personal: true, ...fromDefault })} className="mt-3 text-[13px] font-medium text-primary hover:underline disabled:opacity-50">
            Reset to the default view
          </button>
        </>
      ) : (
        <>
          <p className="mt-4 rounded-lg bg-surface-muted px-3 py-2 text-xs text-muted">You&apos;re using the default view (below). Switch on your personal view to change it for yourself.</p>
          <ViewTable rows={rows} types={types} order={fromDefault.order} hidden={fromDefault.hidden} editable={false} label="Default view" onSave={async () => {}} />
        </>
      )}
    </>
  );
}

// On/off switch like SleekFlow's: green track with the white knob on the right when on, grey with it on the left when off
function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[22px] w-10 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 ${checked ? 'bg-success' : 'bg-faint/50'}`}
    >
      <span
        aria-hidden="true"
        style={{ backgroundColor: '#fff', boxShadow: '0 1px 3px rgb(0 0 0 / 0.3)' }}
        className={`pointer-events-none inline-block h-[18px] w-[18px] rounded-full transition-transform duration-200 ${checked ? 'translate-x-[18px]' : 'translate-x-0'}`}
      />
    </button>
  );
}

// Sequence · Property name · Property type · Shown. Drag a row by its handle (or use ↑ ↓) to reorder; every change
// is saved at once. At least one property stays shown.
function ViewTable({
  rows,
  types,
  order: savedOrder,
  hidden: savedHidden,
  editable,
  label,
  onSave,
  onEditRow,
  onRemoveRow,
}: {
  rows: PropertyRow[];
  types: ContactOption[];
  order: string[];
  hidden: string[];
  editable: boolean;
  label: string;
  onSave: (order: string[], hidden: string[]) => Promise<void>;
  onEditRow?: (row: PropertyRow) => void;
  onRemoveRow?: (row: PropertyRow) => void;
}) {
  const [order, setOrder] = useState(savedOrder);
  const [hidden, setHidden] = useState(savedHidden);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [status, setStatus] = useState<'' | 'saving' | 'saved'>('');
  const [error, setError] = useState('');
  const savedKey = `${savedOrder.join()}|${savedHidden.join()}`;
  useEffect(() => {
    setOrder(savedOrder);
    setHidden(savedHidden);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  async function commit(nextOrder: string[], nextHidden: string[]) {
    const before = { order, hidden };
    setOrder(nextOrder);
    setHidden(nextHidden);
    setStatus('saving');
    setError('');
    try {
      await onSave(nextOrder, nextHidden);
      setStatus('saved');
    } catch (e) {
      setOrder(before.order);
      setHidden(before.hidden);
      setStatus('');
      setError((e as Error).message);
    }
  }
  const move = (key: string, to: number) => {
    const from = order.indexOf(key);
    if (from < 0 || to < 0 || to >= order.length || to === from) return;
    const next = order.filter((k) => k !== key);
    next.splice(to, 0, key);
    commit(next, hidden);
  };

  const byKey = new Map(rows.map((r) => [r.key, r] as const));
  return (
    <>
      <div className="mt-4 flex h-5 items-center justify-end text-[11px]">
        {status === 'saving' && <span className="text-faint">Saving…</span>}
        {status === 'saved' && <span className="text-success">{label} saved</span>}
      </div>
      {error && <p className="mb-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full text-left text-[13px]" aria-label={label}>
          <thead>
            <tr className="border-b border-line bg-surface-muted text-[12px] font-semibold text-ink">
              <th className="w-10 px-2 py-3" aria-label="Drag" />
              <th className="w-28 px-3 py-3">Sequence</th>
              <th className="px-3 py-3">Property name</th>
              <th className="px-3 py-3">Property type</th>
              <th className="w-28 px-3 py-3">Shown</th>
              {onEditRow && <th className="w-24 px-3 py-3" aria-label="Actions" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {order.map((key, i) => {
              const row = byKey.get(key as PropertyRow['key']);
              if (!row) return null;
              const shown = !hidden.includes(key);
              const locked = shown && order.filter((k) => !hidden.includes(k)).length === 1; // the last one shown
              const canDrag = editable;
              return (
                <tr
                  key={key}
                  data-key={key}
                  draggable={canDrag}
                  onDragStart={(e) => {
                    setDragging(key);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', key);
                  }}
                  onDragOver={(e) => {
                    if (!dragging) return;
                    e.preventDefault();
                    setOver(key);
                  }}
                  onDragLeave={() => setOver((o) => (o === key ? null : o))}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragging) move(dragging, i);
                    setDragging(null);
                    setOver(null);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  className={`group ${dragging === key ? 'opacity-40' : ''} ${over === key && dragging !== key ? 'bg-primary/5' : ''}`}
                >
                  <td className="px-2 py-3 text-center">
                    {canDrag && (
                      <span className="inline-flex cursor-grab text-faint active:cursor-grabbing" title="Drag to reorder" aria-hidden="true">
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                          <circle cx="9" cy="6" r="1.5" />
                          <circle cx="15" cy="6" r="1.5" />
                          <circle cx="9" cy="12" r="1.5" />
                          <circle cx="15" cy="12" r="1.5" />
                          <circle cx="9" cy="18" r="1.5" />
                          <circle cx="15" cy="18" r="1.5" />
                        </svg>
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3 tabular-nums text-body">
                    <span className="flex items-center gap-2">
                      {i + 1}
                      {canDrag && (
                        <span className="flex opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                          <button type="button" onClick={() => move(key, i - 1)} disabled={i === 0} aria-label={`Move ${row.label} up`} className="rounded px-1 text-faint hover:text-ink disabled:invisible">
                            ↑
                          </button>
                          <button type="button" onClick={() => move(key, i + 1)} disabled={i >= order.length - 1} aria-label={`Move ${row.label} down`} className="rounded px-1 text-faint hover:text-ink disabled:invisible">
                            ↓
                          </button>
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-ink" title={row.originalLabel ? `Renamed from ${row.originalLabel}` : undefined}>
                    {row.custom ? row.label : `${row.label} (Default)`}
                  </td>
                  <td className="px-3 py-3 text-body-soft">{propertyTypeLabel(row, types)}</td>
                  <td className="px-3 py-3">
                    <Switch
                      checked={shown}
                      disabled={!editable || locked || status === 'saving'}
                      label={`Show ${row.label}`}
                      onChange={(show) => commit(order, show ? hidden.filter((k) => k !== key) : [...hidden, key])}
                    />
                  </td>
                  {onEditRow && (
                    <td className="px-3 py-3">
                      <span className="flex items-center gap-1">
                        <button type="button" onClick={() => onEditRow(row)} aria-label={`Edit ${row.label}`} title="Edit" className={iconButton}>
                          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
                          </svg>
                        </button>
                        {row.custom && onRemoveRow && (
                          <button type="button" onClick={() => onRemoveRow(row)} aria-label={`Remove ${row.label}`} title="Remove" className={`${iconButton} hover:text-danger`}>
                            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
                            </svg>
                          </button>
                        )}
                      </span>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

const iconButton = 'flex h-8 w-8 items-center justify-center rounded-lg text-body-soft transition hover:bg-surface-muted hover:text-ink';
const fieldLabel = 'mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-muted';
const readOnly = 'w-full rounded-lg bg-surface-strong px-3.5 py-2.5 text-sm text-muted';

// "Create new column" (name, key made from it, type, and choices for Options) or edit one: rename any property;
// an added Options property can also change its choices. Key and type never change.
function PropertyModal({
  mode,
  row,
  property,
  types,
  onSavedView,
  onClose,
}: {
  mode: 'create' | 'edit';
  row: PropertyRow | null;
  property: CustomProperty | null;
  types: ContactOption[];
  onSavedView: (v: PropertyView) => void;
  onClose: () => void;
}) {
  const standard = mode === 'edit' && !row?.custom;
  // Standard properties with a workspace choice list (Lead source, Priority)
  const choiceField = standard && CHOICE_FIELDS.includes(row!.key as ChoiceField) ? (row!.key as ChoiceField) : null;
  const [stdChoices, setStdChoices] = useState<{ value?: string; label: string }[] | null>(null);
  const [counts, setCounts] = useState<Map<string | null, number>>(new Map());
  const [confirmRemoved, setConfirmRemoved] = useState(false);
  useEffect(() => {
    if (!choiceField) return;
    fetchContactFieldOptions(true)
      .then((o) => setStdChoices((choiceField === 'leadSource' ? o.leadSources : o.priorities).map((c) => ({ value: c.value, label: c.label }))))
      .catch((e) => setError((e as Error).message));
    fetchFieldChoiceCounts(choiceField)
      .then((rows) => setCounts(new Map(rows.map((r) => [r.value, r.count]))))
      .catch(() => {});
  }, [choiceField]);
  const [name, setName] = useState(mode === 'edit' ? (row?.label ?? '') : '');
  const [type, setType] = useState(property?.type ?? '');
  const [choices, setChoices] = useState<string[]>(property?.options.length ? property.options : ['']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    // Esc closes the dialog, unless a dropdown inside it used it to close itself
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && !busy && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const key = mode === 'create' ? propertyKey(name) : standard ? row!.key : property?.key ?? '';
  const withChoices = type === 'options';
  const cleanChoices = choices.map((c) => c.trim()).filter(Boolean);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!standard && !name.trim()) return setError('Enter a property name');
    if (mode === 'create' && !type) return setError('Choose a property type');
    if (withChoices && !cleanChoices.length) return setError('Add at least one choice');
    const keptChoices = (stdChoices ?? []).map((c) => ({ ...c, label: c.label.trim() })).filter((c) => c.label);
    if (choiceField && !keptChoices.length) return setError('Keep at least one choice');
    // Removing a choice clears it from its contacts: say how many first
    const removedCount = choiceField ? [...counts].filter(([v]) => v && !keptChoices.some((c) => c.value === v)).reduce((n, [, c]) => n + c, 0) : 0;
    if (removedCount && !confirmRemoved) {
      setConfirmRemoved(true);
      return setError(`${removedCount} contact${removedCount === 1 ? ' has' : 's have'} a choice you removed; it will be cleared from them. Click Save again to continue.`);
    }
    setBusy(true);
    try {
      if (mode === 'create') {
        await createCustomProperty({ name: name.trim(), type, ...(withChoices ? { options: cleanChoices } : {}) });
        showToast(`prop:${Date.now()}`, '', `Column “${name.trim()}” created.`, 'Contact properties');
      } else if (standard) {
        // Same as the original name (or empty) = back to it
        const next = name.trim() === (row!.originalLabel ?? row!.label) ? '' : name.trim();
        if (name.trim() !== row!.label) onSavedView(await renameStandardProperty(row!.key, next));
        if (choiceField) await saveFieldChoices(choiceField, keptChoices);
        showToast(`prop:${Date.now()}`, '', next ? `Renamed to “${next}”.` : `Back to “${row!.originalLabel ?? row!.label}”.`, 'Contact properties');
      } else {
        await updateCustomProperty(property!.id, { name: name.trim(), ...(withChoices ? { options: cleanChoices } : {}) });
        showToast(`prop:${Date.now()}`, '', `“${name.trim()}” saved.`, 'Contact properties');
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="property-modal-title"
        onSubmit={submit}
        className="w-full max-w-xl rounded-2xl bg-surface p-8 shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id="property-modal-title" className="text-xl font-bold text-ink">
            {mode === 'create' ? 'Create new column' : 'Edit column'}
          </h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className={iconButton}>
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <label htmlFor="property-name" className={`${fieldLabel} mt-6`}>
          Name
        </label>
        <input
          id="property-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          placeholder={standard ? (row!.originalLabel ?? row!.label) : 'Enter property name'}
          className={inputClass}
        />
        {standard && row!.originalLabel && (
          <button type="button" onClick={() => setName(row!.originalLabel!)} className="mt-1.5 text-[12px] font-medium text-primary hover:underline">
            Use the original name ({row!.originalLabel})
          </button>
        )}

        <p className={`${fieldLabel} mt-5`}>Property key</p>
        <p className={`${readOnly} ${key ? 'font-mono text-[13px] text-body' : ''}`} aria-label="Property key">
          {key || 'Enter property name'}
        </p>

        <label htmlFor="property-type" className={`${fieldLabel} mt-5`}>
          Property type
        </label>
        {mode === 'create' ? (
          <SearchSelect
            id="property-type"
            label="Property type"
            value={type}
            options={types}
            onChange={setType}
            filter={(list, q) => list.filter((t) => t.label.toLowerCase().includes(q.trim().toLowerCase().replace(/\s+/g, '')))}
            placeholder=""
          />
        ) : (
          <p className={readOnly}>{row ? propertyTypeLabel(row, types) : ''}</p>
        )}

        {row?.key === 'leadStage' && (
          <p className="mt-5 rounded-lg bg-surface-muted px-3.5 py-2.5 text-[13px] text-body">
            Lead stages are managed in{' '}
            <a href="/settings/lifecycle" className="font-semibold text-primary hover:underline">
              Customer lifecycle
            </a>
            .
          </p>
        )}
        {choiceField && (
          <div className="mt-5">
            <p className={fieldLabel}>Choices</p>
            {!stdChoices ? (
              <p className="text-xs text-faint">Loading…</p>
            ) : (
              <ul className="max-h-56 space-y-2 overflow-y-auto pr-1">
                {stdChoices.map((c, i) => (
                  <li key={c.value ?? `new-${i}`} className="flex items-center gap-2">
                    <input
                      value={c.label}
                      onChange={(e) => {
                        setConfirmRemoved(false);
                        setStdChoices((list) => list!.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)));
                      }}
                      maxLength={60}
                      placeholder={`Choice ${i + 1}`}
                      aria-label={`Choice ${i + 1}`}
                      className={inputClass}
                    />
                    <span className="w-20 shrink-0 text-right text-[11px] tabular-nums text-faint">
                      {c.value ? `${counts.get(c.value) ?? 0} contacts` : 'new'}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmRemoved(false);
                        setStdChoices((list) => list!.filter((_, j) => j !== i));
                      }}
                      aria-label={`Remove choice ${i + 1}`}
                      className={`${iconButton} shrink-0 hover:text-danger`}
                    >
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" onClick={() => setStdChoices((list) => [...(list ?? []), { label: '' }])} className="mt-2 text-[13px] font-medium text-primary hover:underline">
              + Add choice
            </button>
          </div>
        )}
        {withChoices && (
          <div className="mt-5">
            <p className={fieldLabel}>Choices</p>
            <ul className="max-h-56 space-y-2 overflow-y-auto pr-1">
              {choices.map((c, i) => (
                <li key={i} className="flex items-center gap-2">
                  <input
                    value={c}
                    onChange={(e) => setChoices((list) => list.map((x, j) => (j === i ? e.target.value : x)))}
                    maxLength={60}
                    placeholder={`Choice ${i + 1}`}
                    aria-label={`Choice ${i + 1}`}
                    className={inputClass}
                  />
                  <button
                    type="button"
                    onClick={() => setChoices((list) => (list.length > 1 ? list.filter((_, j) => j !== i) : ['']))}
                    aria-label={`Remove choice ${i + 1}`}
                    className={`${iconButton} shrink-0 hover:text-danger`}
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" onClick={() => setChoices((list) => [...list, ''])} className="mt-2 text-[13px] font-medium text-primary hover:underline">
              + Add choice
            </button>
          </div>
        )}

        {error && <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
        <div className="mt-8 flex justify-end">
          <button type="submit" disabled={busy} className="rounded-lg bg-primary px-8 py-2.5 text-sm font-semibold text-on-primary transition hover:bg-primary-hover disabled:opacity-60">
            {busy ? 'Saving…' : mode === 'create' ? 'Create' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
