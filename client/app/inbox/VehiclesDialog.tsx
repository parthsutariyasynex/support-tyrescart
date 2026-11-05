'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { showToast } from '@/lib/toasts';
import {
  type CatalogOption,
  addVehicleMake,
  addVehicleModel,
  addVehicleYear,
  type Vehicle,
  type VehicleCustomer,
  VEHICLES_EVENT,
  addVehicle,
  deleteVehicle,
  listVehicles,
  updateVehicle,
  vehicleMakes,
  vehicleModels,
  vehicleTitle,
  vehicleYears,
} from '@/lib/vehicles';
import { addTyreSize, listTyreSizes, sameTyreSize } from '@/lib/tyreSizes';
import { AddableSelect } from './AddableSelect';
import { CountryFlag } from './CountryFlag';
import type { VehicleSelectOption } from './VehicleSelect';

// The TyresCart car (sized by width only; the height follows its 2.8:1 ratio)
export const CarIcon = ({
  className = 'w-[1.375rem]',
}: {
  className?: string;
}) => (
  <svg
    className={`h-auto shrink-0 ${className}`}
    viewBox="0 0 47.747 16.977"
    fill="currentColor"
    aria-hidden="true"
  >
    <path
      transform="translate(122.615 -135.806)"
      d="M-122.615,146.25a14.294,14.294,0,0,0,.9,1.807,1.609,1.609,0,0,0,.935.518c1.073.245,2.161.424,3.313.642a4.4,4.4,0,0,1,2.574-3.96,4.107,4.107,0,0,1,2.686-.294,4.432,4.432,0,0,1,3.413,4.935l21.435.432a4.315,4.315,0,0,1,1.162-4.224,4.061,4.061,0,0,1,3.118-1.236,4.36,4.36,0,0,1,4.163,5.139c.687-.113,1.356-.194,2.011-.338,1.472-.323,1.693-.616,1.987-2.158a5.746,5.746,0,0,0-.342-2.547,2.327,2.327,0,0,0-1.6-1.7,39.349,39.349,0,0,0-7.593-2.017,16.658,16.658,0,0,1-3.88-1.389c-1.793-.78-3.566-1.607-5.351-2.407a21.266,21.266,0,0,0-9.744-1.617,33.618,33.618,0,0,0-11.928,2.885,20.127,20.127,0,0,1-5.156,1.381c-1.089.153-1.255.357-1.256,1.444,0,.358-.012.716,0,1.073a2.047,2.047,0,0,1-.454,1.677,2.842,2.842,0,0,0-.391.931Zm30.034-4.853a.274.274,0,0,1-.12.014c-2.485-.069-4.97-.144-7.455-.2-.27-.007-.33-.139-.381-.359-.23-.982-.476-1.96-.714-2.939-.071-.291-.135-.584-.222-.962,3.475.284,6.78.76,9.465,2.868Zm-9.58-.407a.745.745,0,0,1-.153.049c-2.3-.068-4.594-.135-6.89-.218a.451.451,0,0,1-.317-.243,1.572,1.572,0,0,1,.174-1.881,8.174,8.174,0,0,0,.455-.7.938.938,0,0,1,.418-.325,17.885,17.885,0,0,1,5.381-.687.411.411,0,0,1,.315.232C-102.558,138.468-102.363,139.723-102.161,140.989Zm-11.361-.195a1.036,1.036,0,0,1,.612-1.247c.563-.291,1.137-.561,1.714-.823.506-.23,1.022-.436,1.534-.653-.557.9-1.154,1.725-1.762,2.543a.451.451,0,0,1-.3.172C-112.325,140.8-112.928,140.794-113.522,140.794Z"
    />
    <path
      transform="translate(-503.07 -304.356)"
      d="M512.565,314.14a3.6,3.6,0,1,0,3.6,3.624A3.629,3.629,0,0,0,512.565,314.14Zm.312,1.314,1.1.473c-.269.253-.451.444-.653.61-.235.192-.407.1-.443-.176A8.107,8.107,0,0,1,512.877,315.454Zm0,4.553c0-.385-.021-.647.006-.906s.2-.346.412-.185.426.372.718.632Zm-2.582-2.585.5-1.186c.23.3.4.5.543.717.06.089.121.236.086.313a.392.392,0,0,1-.29.149C510.886,317.437,510.64,317.422,510.295,317.422Zm.463,1.772-.445-1.135c.352,0,.615-.021.874.005.3.03.368.2.177.436C511.2,318.705,511.02,318.9,510.757,319.194Zm4.1-1.678-1.151-.247c.2-.267.4-.534.6-.8.012-.015.057,0,.144-.009Zm-.416,1.52-.189.072c-.151-.194-.314-.38-.449-.584a.47.47,0,0,1-.082-.321c.014-.063.158-.13.248-.137.259-.018.52-.006.861-.006Zm-2.194-3.58a7.38,7.38,0,0,1-.008.906c-.039.276-.2.369-.445.165-.2-.165-.407-.324-.714-.568Zm-1.139,4.083c.3-.255.48-.424.679-.567a.428.428,0,0,1,.309-.082c.067.017.138.154.145.242.019.255.007.513.007.871Z"
    />
    <path
      transform="translate(72.415 -304.356)"
      d="M-32.965,314.14a3.616,3.616,0,0,0-3.619,3.614,3.631,3.631,0,0,0,3.609,3.579,3.607,3.607,0,0,0,3.585-3.545A3.6,3.6,0,0,0-32.965,314.14Zm.3,1.326,1.144.474c-.3.256-.5.447-.72.612s-.389.1-.418-.169S-32.665,315.835-32.665,315.466Zm1.5.812.453,1.144c-.355,0-.617.017-.876,0-.306-.025-.363-.2-.185-.434C-31.619,316.775-31.436,316.585-31.17,316.278Zm.472,1.782-.484,1.09c-.26-.282-.452-.465-.612-.673s-.1-.386.177-.413S-31.093,318.06-30.7,318.06Zm-2.6-2.6c0,.355.012.614-.007.871-.006.088-.074.225-.14.244a.419.419,0,0,1-.314-.071c-.208-.15-.4-.328-.682-.57Zm-1.483.8c.25.3.428.492.58.7a.415.415,0,0,1,.067.313c-.019.066-.156.131-.244.138-.258.018-.518.007-.863.007Zm.011,2.963-.474-1.164c.356,0,.619-.018.878,0,.287.025.382.18.194.428C-34.341,318.712-34.523,318.919-34.774,319.224Zm2.107.794c0-.357-.014-.6.007-.846a.379.379,0,0,1,.15-.279.394.394,0,0,1,.308.076c.213.145.409.314.708.55Zm-1.762-.474c.29-.253.468-.426.666-.572a.429.429,0,0,1,.312-.081c.065.016.136.154.142.242.019.258.007.519.007.871Z"
    />
  </svg>
);

// "Toyota Land Cruiser 2022 (A 12345)": the plate only when there is one
const vehicleName = (v: Vehicle) => (v.plateNumber ? `${vehicleTitle(v)} (${v.plateNumber})` : vehicleTitle(v));

// "15 Mar 2024" from yyyy-mm-dd (a calendar day: no time zone shift)
const dayLabel = (v: string) => new Date(`${v}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

// Registration date, shown as DD/MM/YY; kept and saved as yyyy-mm-dd. "2024-03-15" → "15/03/24"
const isoToDmy = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(2, 4)}` : v);

// Today in the viewer's own time zone (yyyy-mm-dd): a registration date can't be after it
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Each customer's last loaded list, so opening the dialog again shows it at once (then refreshes it)
const vehicleListCache = new Map<string, Vehicle[]>();

// The customer's vehicles: who (name, WhatsApp number) at the top, every saved vehicle with Edit and Delete, and the
// form below to add another one (or edit the chosen one). The customer always comes from the open chat; nobody types
// it in. Reloads live when anyone adds, edits or deletes one of this customer's vehicles.
export function VehiclesDialog({ customer, onClose }: { customer: VehicleCustomer; onClose: () => void }) {
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(() => vehicleListCache.get(customer.id) ?? null);
  const [listError, setListError] = useState('');
  const [editing, setEditing] = useState<Vehicle | null>(null);
  const [formRound, setFormRound] = useState(0); // a new number = an empty form again
  const [saving, setSaving] = useState(false);
  const titleId = useId();
  const formRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    () =>
      listVehicles(customer.id)
        .then((v) => {
          vehicleListCache.set(customer.id, v);
          setVehicles(v);
          setListError('');
        })
        .catch((e) => setListError((e as Error).message)),
    [customer.id],
  );
  useEffect(() => {
    load();
    const onChanged = (e: Event) => (e as CustomEvent<{ contactId: string }>).detail?.contactId === customer.id && load();
    window.addEventListener(VEHICLES_EVENT, onChanged);
    return () => window.removeEventListener(VEHICLES_EVENT, onChanged);
  }, [load, customer.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !saving && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [saving, onClose]);

  const startEdit = (v: Vehicle) => {
    setEditing(v);
    // The form is below the list: bring it into view
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };
  const resetForm = () => {
    setEditing(null);
    setFormRound((n) => n + 1);
  };

  const count = vehicles?.length ?? 0;
  const listReady = vehicles !== null || !!listError;
  const name = customer.name?.trim() || `+${customer.waId}`;
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-shadow/40 p-4 sm:items-start sm:pt-[6dvh]" onMouseDown={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="flex max-h-[92dvh] w-full min-w-0 max-w-2xl flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl sm:max-h-[88dvh]">
        {/* Customer: from the open chat */}
        <div className="flex shrink-0 items-center gap-3 border-b border-line-soft px-5 py-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
            <CarIcon className="w-7" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-[15px] font-bold leading-tight text-ink">
              {name}
            </h2>
            <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[13px] text-muted">
              <CountryFlag waId={customer.waId} />
              {/* The number is already the title when the customer hasn't shared a name */}
              <span className="truncate">{customer.name?.trim() ? `+${customer.waId}` : 'WhatsApp contact'}</span>
              {vehicles && (
                <span className="shrink-0">
                  · {count} {count === 1 ? 'vehicle' : 'vehicles'}
                </span>
              )}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-body-soft hover:bg-surface-muted disabled:opacity-50">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 [scrollbar-gutter:stable]">
          {/* Saved vehicles */}
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Saved vehicles{vehicles ? ` (${count})` : ''}</h3>
          {listError && <p className="mt-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{listError}</p>}
          {vehicles === null ? (
            !listError && (
              <div className="mt-2 rounded-xl border border-line px-4 py-3" role="status" aria-label="Loading vehicles">
                <div className="h-4 w-48 animate-pulse rounded bg-surface-strong" />
                <div className="mt-2.5 h-3 w-64 max-w-full animate-pulse rounded bg-surface-strong" />
              </div>
            )
          ) : count === 0 ? (
            <p className="mt-2 rounded-xl border border-dashed border-line px-4 py-5 text-center text-xs text-muted">No vehicles yet. Add the first one below.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {vehicles.map((v) => (
                <VehicleCard
                  key={v.id}
                  vehicle={v}
                  isEditing={editing?.id === v.id}
                  onEdit={() => startEdit(v)}
                  onDeleted={() => {
                    if (editing?.id === v.id) resetForm();
                    load();
                  }}
                />
              ))}
            </ul>
          )}

          {/* Add another vehicle, or edit the chosen one. Shown once the list above has loaded (or failed to), so
              the list arriving never pushes the form down while someone is typing in it. */}
          {listReady && (
          <section ref={formRef} className="mt-5 scroll-mt-4 border-t border-line-soft pt-4">
            <div className="mb-3 flex h-6 items-center justify-between gap-2">
              <h3 className="flex min-w-0 items-center text-[11px] font-semibold uppercase tracking-wide text-muted">
                {editing ? (
                  <>
                    <span className="shrink-0">Edit vehicle:</span>
                    <span className="ml-1.5 truncate normal-case tracking-normal text-[13px] font-bold text-ink">{vehicleTitle(editing)}</span>
                    {editing.plateNumber && <span className="ml-2 shrink-0 rounded border border-line bg-surface-strong px-1.5 py-px font-mono text-[11px] font-semibold normal-case tracking-wide text-body">{editing.plateNumber}</span>}
                  </>
                ) : count ? (
                  'Add another vehicle'
                ) : (
                  'Add vehicle'
                )}
              </h3>
              {editing && (
                <button type="button" disabled={saving} onClick={resetForm} className="shrink-0 text-[12px] font-medium text-primary hover:underline disabled:opacity-50">
                  + Add new instead
                </button>
              )}
            </div>
            <VehicleForm
              key={editing ? `edit-${editing.id}` : `new-${formRound}`}
              contactId={customer.id}
              vehicle={editing}
              onSavingChange={setSaving}
              onSaved={(wasEdit) => {
                showToast(`vehicle:${Date.now()}`, '', wasEdit ? 'Vehicle updated' : 'Vehicle added');
                resetForm();
                load();
              }}
            />
          </section>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line-soft px-5 py-3">
          {editing ? (
            <button type="button" disabled={saving} onClick={resetForm} className="min-w-24 rounded-lg px-4 py-2 text-[13px] font-medium text-body hover:bg-surface-strong disabled:opacity-50">
              Cancel edit
            </button>
          ) : (
            <button type="button" disabled={saving} onClick={onClose} className="min-w-24 rounded-lg px-4 py-2 text-[13px] font-medium text-body hover:bg-surface-strong disabled:opacity-50">
              Close
            </button>
          )}
          <button type="submit" form="vehicle-form" disabled={saving || !listReady} className="min-w-32 rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50">
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add vehicle'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// One saved vehicle: make, model, year, plate, tyres, registration date and remarks; Edit and Delete (asks first)
function VehicleCard({ vehicle: v, isEditing, onEdit, onDeleted }: { vehicle: Vehicle; isEditing: boolean; onEdit: () => void; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function remove() {
    setBusy(true);
    setError('');
    try {
      await deleteVehicle(v.id);
      showToast(`vehicle:${Date.now()}`, '', 'Vehicle deleted');
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      setConfirming(false);
    }
  }
  const iconButton = 'flex h-8 w-8 items-center justify-center rounded-lg text-body-soft transition hover:bg-surface-muted disabled:opacity-50';
  return (
    <li className={`rounded-xl border px-4 py-3 transition ${isEditing ? 'border-primary bg-primary-subtle' : 'border-line bg-surface'}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-ink">{vehicleTitle(v)}</span>
            {v.plateNumber && <span className="rounded border border-line bg-surface-strong px-1.5 py-px font-mono text-[11px] font-semibold tracking-wide text-body">{v.plateNumber}</span>}
            {isEditing && <span className="rounded-full bg-primary px-2 py-px text-[10px] font-semibold text-on-primary">Editing</span>}
          </div>
          <dl className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
            <div className="flex gap-1.5">
              <dt className="shrink-0 text-muted">Tyre size 1:</dt>
              <dd className="text-body">{v.tireSize1}</dd>
            </div>
            {v.tireSize2 && (
              <div className="flex gap-1.5">
                <dt className="shrink-0 text-muted">Tyre size 2:</dt>
                <dd className="text-body">{v.tireSize2}</dd>
              </div>
            )}
            {v.registrationDate && (
              <div className="flex gap-1.5">
                <dt className="shrink-0 text-muted">Registered:</dt>
                <dd className="text-body">{isoToDmy(v.registrationDate)}</dd>
              </div>
            )}
            {v.lastServiceDate && (
              <div className="flex gap-1.5">
                <dt className="shrink-0 text-muted">Last service:</dt>
                <dd className="text-body">{dayLabel(v.lastServiceDate)}</dd>
              </div>
            )}
          </dl>
          {v.remarks && <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap rounded-lg bg-surface-muted px-2.5 py-1.5 text-xs text-body">{v.remarks}</p>}
          {error && <p className="mt-1.5 text-[11px] text-danger">{error}</p>}
        </div>
        {confirming ? (
          <span className="flex h-8 shrink-0 items-center gap-1">
            <span className="mr-1 text-xs text-body">Delete?</span>
            <button type="button" disabled={busy} onClick={() => setConfirming(false)} className="rounded-md px-2 py-1 text-xs text-body-soft hover:bg-surface-muted disabled:opacity-50">
              Cancel
            </button>
            <button type="button" disabled={busy} onClick={remove} className="min-w-16 rounded-md bg-danger px-2.5 py-1 text-xs font-semibold text-on-primary disabled:opacity-50">
              {busy ? 'Deleting…' : 'Delete'}
            </button>
          </span>
        ) : (
          <span className="flex shrink-0 gap-0.5">
            <button type="button" onClick={onEdit} aria-label={`Edit ${vehicleName(v)}`} title="Edit" className={`${iconButton} hover:text-ink`}>
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z" />
              </svg>
            </button>
            <button type="button" onClick={() => setConfirming(true)} aria-label={`Delete ${vehicleName(v)}`} title="Delete" className={`${iconButton} hover:text-danger`}>
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
              </svg>
            </button>
          </span>
        )}
      </div>
    </li>
  );
}

type Form = { make: string; model: string; year: string; plateNumber: string; registrationDate: string; tireSize1: string; tireSize2: string; remarks: string };
type Field = keyof Form;

function validate(f: Form): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {};
  const maxYear = new Date().getFullYear() + 1;
  // Make, model and year are optional; a year that's filled in must be a real one
  if (f.year.trim() && !/^\d{4}$/.test(f.year.trim())) errors.year = 'Enter a 4-digit year';
  else if (f.year.trim() && (+f.year < 1900 || +f.year > maxYear)) errors.year = `Enter a year from 1900 to ${maxYear}`;
  if (!f.tireSize1.trim()) errors.tireSize1 = 'Select tyre size 1';
  if (f.registrationDate && f.registrationDate > localToday()) errors.registrationDate = 'The registration date can’t be in the future';
  return errors;
}

// Every year the form accepts, newest first: the Year list when the catalog has no years for the model
function allYears() {
  const max = new Date().getFullYear() + 1;
  return Array.from({ length: max - 1899 }, (_, i) => String(max - i));
}

type Loaded<T> = { key: string; data: T | null; error: string };
const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
const byName = (a: CatalogOption, b: CatalogOption) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
const toOptions = (list: CatalogOption[]): VehicleSelectOption[] => list.map((o) => ({ value: o.name, label: o.name, logo: o.logo }));
// Adds one option to a loaded list (once, kept A–Z)
const withOption = (list: CatalogOption[] | null, o: CatalogOption) => (list && !list.some((x) => nameKey(x.name) === nameKey(o.name)) ? [...list, o].sort(byName) : list);

// Make → Model → Year lists for the chosen make and model (by name, as saved): the Wheel API's catalog plus the ones
// added with "+ Add New …". The add* functions put a just-added value into the list on screen.
function useVehicleCatalog(make: string, model: string) {
  const [makes, setMakes] = useState<Loaded<CatalogOption[]>>({ key: '', data: null, error: '' });
  const [models, setModels] = useState<Loaded<CatalogOption[]>>({ key: '', data: null, error: '' });
  const [years, setYears] = useState<Loaded<number[]>>({ key: '', data: null, error: '' });

  useEffect(() => {
    let live = true;
    vehicleMakes()
      .then((r) => live && setMakes({ key: 'makes', data: r.options, error: r.error ?? '' }))
      .catch((e) => live && setMakes({ key: 'makes', data: [], error: (e as Error).message }));
    return () => {
      live = false;
    };
  }, []);

  const makeKey = make.trim() ? nameKey(make) : '';
  useEffect(() => {
    if (!makeKey) return;
    let live = true;
    setModels({ key: makeKey, data: null, error: '' });
    vehicleModels(make)
      .then((r) => live && setModels({ key: makeKey, data: r.options, error: r.error ?? '' }))
      .catch((e) => live && setModels({ key: makeKey, data: [], error: (e as Error).message }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [makeKey]);

  const yearsKey = makeKey && model.trim() ? `${makeKey}|${nameKey(model)}` : '';
  useEffect(() => {
    if (!yearsKey) return;
    let live = true;
    setYears({ key: yearsKey, data: null, error: '' });
    vehicleYears(make, model)
      .then((r) => live && setYears({ key: yearsKey, data: r.years, error: r.error ?? '' }))
      .catch((e) => live && setYears({ key: yearsKey, data: [], error: (e as Error).message }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yearsKey]);

  const modelList = makeKey && models.key === makeKey ? models.data : null;
  const yearList = yearsKey && years.key === yearsKey ? years.data : null;
  // The catalog's years for the model (with any added); none listed: every year, and nothing to add
  const yearValues = !yearsKey ? allYears() : yearList === null ? null : yearList.length ? yearList.map(String) : allYears();
  return {
    makes: makes.data ? toOptions(makes.data) : null,
    makesError: makes.error,
    models: !makeKey ? [] : modelList ? toOptions(modelList) : null,
    modelsError: makeKey && models.key === makeKey ? models.error : '',
    years: yearValues ? yearValues.map((y) => ({ value: y, label: y })) : null,
    yearsError: yearsKey && years.key === yearsKey ? years.error : '',
    canAddYear: !!yearList?.length,
    addMake: (o: CatalogOption) => setMakes((m) => ({ ...m, data: withOption(m.data, o) })),
    addModel: (o: CatalogOption) => setModels((m) => (m.key === makeKey ? { ...m, data: withOption(m.data, o) } : m)),
    addYear: (y: number) =>
      setYears((m) => (m.key === yearsKey && m.data && !m.data.includes(y) ? { ...m, data: [...m.data, y].sort((a, b) => b - a) } : m)),
  };
}

// Add (vehicle = null) or edit one. The submit button is the dialog's footer button (form="vehicle-form").
function VehicleForm({
  contactId,
  vehicle,
  onSavingChange,
  onSaved,
}: {
  contactId: string;
  vehicle: Vehicle | null;
  onSavingChange: (saving: boolean) => void;
  onSaved: (wasEdit: boolean) => void;
}) {
  const [form, setForm] = useState<Form>({
    make: vehicle?.make ?? '',
    model: vehicle?.model ?? '',
    year: vehicle?.year != null ? String(vehicle.year) : '',
    plateNumber: vehicle?.plateNumber ?? '',
    registrationDate: vehicle?.registrationDate ?? '',
    tireSize1: vehicle?.tireSize1 ?? '',
    tireSize2: vehicle?.tireSize2 ?? '',
    remarks: vehicle?.remarks ?? '',
  });
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState('');
  const errors = submitted ? validate(form) : {};
  const set = (k: Field, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const catalog = useVehicleCatalog(form.make, form.model);
  // Tyre sizes (the server's list file), shared by both tyre size fields: one added in either shows in both
  const [tyreSizes, setTyreSizes] = useState<string[] | null>(null);
  const [tyreSizesError, setTyreSizesError] = useState('');
  useEffect(() => {
    let live = true;
    listTyreSizes()
      .then((list) => live && setTyreSizes(list))
      .catch((e) => {
        if (!live) return;
        setTyreSizes([]);
        setTyreSizesError((e as Error).message);
      });
    return () => {
      live = false;
    };
  }, []);
  // Both tyre size fields share the list (the server's file): a size added in either shows in both
  const tyreSizeProps = {
    options: tyreSizes ? tyreSizes.map((s) => ({ value: s, label: s })) : null,
    loadError: tyreSizesError,
    addNewLabel: '+ Add New Tyre Size',
    addPlaceholder: 'e.g. 205/55 R16',
    addMaxLength: 40,
    uppercase: true,
    check: (size: string) => (size.replace(/\s+/g, '').length > 30 ? 'Keep the tyre size to 30 characters or fewer' : null),
    onAdd: async (size: string) => {
      const added = await addTyreSize(size);
      setTyreSizes(added.sizes);
      return added.size;
    },
    onDuplicate: (size: string) => setTyreSizes((list) => (list && !list.some((s) => sameTyreSize(s, size)) ? [...list, size] : list)),
  };
  // A different make clears the model and year; a different model clears the year (they belonged to the old one)
  const setMake = (v: string) => setForm((f) => (v === f.make ? f : { ...f, make: v, model: '', year: '' }));
  const setModel = (v: string) => setForm((f) => (v === f.model ? f : { ...f, model: v, year: '' }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (busy || Object.keys(validate(form)).length) return;
    setBusy(true);
    onSavingChange(true);
    setServerError('');
    const details = {
      make: form.make.trim() || null,
      model: form.model.trim() || null,
      year: form.year.trim() ? Number(form.year.trim()) : null,
      plateNumber: form.plateNumber.trim().toUpperCase() || null,
      registrationDate: form.registrationDate || null,
      tireSize1: form.tireSize1.trim(),
      tireSize2: form.tireSize2.trim() || null,
      remarks: form.remarks.trim() || null,
    };
    try {
      if (vehicle) await updateVehicle(vehicle.id, details);
      else await addVehicle({ ...details, contactId });
      onSavingChange(false);
      onSaved(!!vehicle);
    } catch (err) {
      setServerError((err as Error).message);
      setBusy(false);
      onSavingChange(false);
    }
  }

  const inputClass = (bad: boolean) =>
    `h-[38px] w-full rounded-lg border bg-surface px-3 text-[13px] text-ink outline-hidden placeholder:text-faint focus:ring-1 ${bad ? 'border-danger focus:border-danger focus:ring-danger' : 'border-line focus:border-primary focus:ring-primary'}`;
  const label = (id: string, text: string, required: boolean) => (
    <label htmlFor={id} className="mb-1.5 block truncate text-[11px] font-semibold text-body-soft">
      {text}
      {required && <span className="text-danger"> *</span>}
    </label>
  );
  // Shown in the gap under the field (absolute): an error appearing never pushes the rows below down
  const problem = (k: Field) => errors[k] && <p className="absolute inset-x-0 top-full mt-0.5 truncate text-[11px] leading-4 text-danger">{errors[k]}</p>;
  const field = (k: Exclude<Field, 'remarks'>, text: string, required: boolean, span: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className={`relative ${span}`}>
      {label(`vehicle-${k}`, text, required)}
      <input id={`vehicle-${k}`} autoComplete="off" value={form[k]} onChange={(e) => set(k, e.target.value)} aria-invalid={!!errors[k]} className={inputClass(!!errors[k])} {...extra} />
      {problem(k)}
    </div>
  );

  return (
    <form id="vehicle-form" onSubmit={submit} noValidate autoComplete="off">
      {/* Row 1: tyre sizes · Row 2: make, model, year · Row 3: plate number, registration date — same rows on every screen size */}
      {/* gap-y-5: room for a field's one-line error under it */}
      <div className="grid grid-cols-6 gap-x-3 gap-y-5 sm:gap-x-4">
        <div className="col-span-3">
          <AddableSelect
            id="vehicle-tireSize1"
            label="Tyre Size 1"
            required
            {...tyreSizeProps}
            value={form.tireSize1}
            onChange={(v) => set('tireSize1', v)}
            error={errors.tireSize1}
            placeholder="Select tyre size"
            autoFocus={!vehicle}
          />
        </div>
        <div className="col-span-3">
          <AddableSelect id="vehicle-tireSize2" label="Tyre Size 2" {...tyreSizeProps} value={form.tireSize2} onChange={(v) => set('tireSize2', v)} placeholder="Rear, if different" />
        </div>
        <div className="col-span-2">
          <AddableSelect
            id="vehicle-make"
            label="Make"
            value={form.make}
            onChange={setMake}
            options={catalog.makes}
            loadError={catalog.makesError}
            placeholder="Select make"
            withLogo
            addNewLabel="+ Add New Make"
            addPlaceholder="e.g. Foton"
            onAdd={async (name) => {
              const added = await addVehicleMake(name);
              catalog.addMake(added);
              return added.name;
            }}
            onDuplicate={(name) => catalog.addMake({ slug: null, name, logo: null, custom: true })}
          />
        </div>
        <div className="col-span-2">
          <AddableSelect
            id="vehicle-model"
            label="Model"
            value={form.model}
            onChange={setModel}
            options={catalog.models}
            loadError={catalog.modelsError}
            placeholder="Select model"
            disabled={!form.make.trim()}
            disabledHint="Select make first"
            addNewLabel="+ Add New Model"
            addPlaceholder="e.g. Tunland"
            onAdd={async (name) => {
              const added = await addVehicleModel(form.make, name);
              catalog.addModel(added);
              return added.name;
            }}
            onDuplicate={(name) => catalog.addModel({ slug: null, name, logo: null, custom: true })}
          />
        </div>
        <div className="col-span-2">
          <AddableSelect
            id="vehicle-year"
            label="Year"
            value={form.year}
            onChange={(v) => set('year', v)}
            options={catalog.years}
            loadError={catalog.yearsError}
            error={errors.year}
            placeholder="Select year"
            disabled={!form.model.trim()}
            disabledHint="Select model first"
            numeric
            canAdd={catalog.canAddYear}
            addNewLabel="+ Add New Year"
            addPlaceholder="e.g. 2027"
            check={(y) => (/^\d{4}$/.test(y) && +y >= 1900 && +y <= new Date().getFullYear() + 1 ? null : `Enter a year from 1900 to ${new Date().getFullYear() + 1}`)}
            onAdd={async (y) => {
              const added = await addVehicleYear(form.make, form.model, Number(y));
              catalog.addYear(added);
              return String(added);
            }}
            onDuplicate={(y) => catalog.addYear(Number(y))}
          />
        </div>
        {field('plateNumber', 'Plate Number', false, 'col-span-3', { maxLength: 20, placeholder: 'e.g. A 12345', style: { textTransform: form.plateNumber ? 'uppercase' : 'none' } })}
        {/* The browser's own date field, so a click anywhere on it opens the calendar (its picker icon is stretched
            over the whole field). Its text would follow the computer's date format, so it's hidden and the date is
            shown on top as DD/MM/YY. */}
        <div className="relative col-span-3">
          {label('vehicle-registrationDate', 'Registration Date', false)}
          <div className="relative">
            <input
              id="vehicle-registrationDate"
              type="date"
              max={localToday()}
              value={form.registrationDate}
              onChange={(e) => set('registrationDate', e.target.value)}
              aria-invalid={!!errors.registrationDate}
              className={`${inputClass(!!errors.registrationDate)} relative cursor-pointer pr-9 text-transparent [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:h-auto [&::-webkit-calendar-picker-indicator]:w-auto [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-0 [&::-webkit-datetime-edit]:opacity-0`}
            />
            <span className={`pointer-events-none absolute inset-y-0 left-3 flex items-center text-[13px] ${form.registrationDate ? 'text-ink' : 'text-faint'}`}>
              {form.registrationDate ? isoToDmy(form.registrationDate) : 'DD/MM/YY'}
            </span>
            <svg className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
          </div>
          {problem('registrationDate')}
        </div>
        <div className="col-span-6">
          {label('vehicle-remarks', 'Remarks', false)}
          <textarea
            autoComplete="off"
            id="vehicle-remarks"
            value={form.remarks}
            onChange={(e) => set('remarks', e.target.value)}
            rows={3}
            placeholder="e.g. Prefers Michelin, rotates tyres every 10,000 km"
            className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-hidden placeholder:text-faint focus:border-primary focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>
      {serverError && <p className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{serverError}</p>}
    </form>
  );
}
