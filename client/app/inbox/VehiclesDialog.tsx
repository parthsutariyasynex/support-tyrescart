'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { showToast } from '@/lib/toasts';
import { type Vehicle, type VehicleCustomer, VEHICLES_EVENT, addVehicle, deleteVehicle, listVehicles, searchVehicleCustomers, vehicleTitle } from '@/lib/vehicles';
import { contactDisplayName } from './avatar';

// The TyresCart site's car (side view, wheels with rims) in the current text colour, so it follows the theme (grey,
// green when active). It's wide (about 2.8:1), so it's sized by width and the height follows.
export const CarIcon = ({ className = 'w-[1.375rem]' }: { className?: string }) => (
  <svg className={`h-auto shrink-0 ${className}`} viewBox="0 0 47.747 16.977" fill="currentColor" aria-hidden="true">
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

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const showDay = (v: string) => new Date(`${v}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

const EMPTY = { plateNumber: '', make: '', model: '', year: '', registrationDate: '', lastServiceDate: '', tireSize1: '', tireSize2: '' };
type Form = typeof EMPTY;

// Chat header → 🚗: the chat customer's vehicles, and "Add vehicle" (CRM customer and tire size 1 required; the
// customer starts as the chat's, any other CRM customer can be picked). Live for everyone (contact:vehicles).
// formOnly (Contact profile → Add Vehicle): just the form, for this customer only; Cancel or saving closes it.
export function VehiclesDialog({ customer, onClose, formOnly = false }: { customer: VehicleCustomer; onClose: () => void; formOnly?: boolean }) {
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [adding, setAdding] = useState(formOnly);
  const [form, setForm] = useState<Form>(EMPTY);
  const [owner, setOwner] = useState<VehicleCustomer | null>(customer);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    listVehicles(customer.id)
      .then(setVehicles)
      .catch((e) => {
        setVehicles([]);
        setError((e as Error).message);
      });
  }, [customer.id]);

  useEffect(() => {
    if (formOnly) return; // no list shown
    load();
    const onChange = (e: Event) => (e as CustomEvent<{ contactId: string }>).detail?.contactId === customer.id && load();
    window.addEventListener(VEHICLES_EVENT, onChange);
    return () => window.removeEventListener(VEHICLES_EVENT, onChange);
  }, [customer.id, load, formOnly]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const problems = {
    owner: !owner ? 'Choose a CRM customer' : '',
    plateNumber: !form.plateNumber.trim() ? 'Enter the plate number' : '',
    make: !form.make.trim() ? 'Enter the make' : '',
    model: !form.model.trim() ? 'Enter the model' : '',
    year: !form.year.trim() ? 'Enter the year' : !/^\d{4}$/.test(form.year.trim()) ? 'Enter a 4-digit year' : '',
    tireSize1: !form.tireSize1.trim() ? 'Enter tire size 1' : '',
  };
  const invalid = Object.values(problems).some(Boolean);

  function openForm() {
    setForm(EMPTY);
    setOwner(customer);
    setTouched(false);
    setError('');
    setAdding(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (invalid || busy || !owner) return;
    setBusy(true);
    setError('');
    try {
      await addVehicle({
        contactId: owner.id,
        plateNumber: form.plateNumber.trim(),
        make: form.make.trim(),
        model: form.model.trim(),
        year: Number(form.year.trim()),
        registrationDate: form.registrationDate || null,
        lastServiceDate: form.lastServiceDate || null,
        tireSize1: form.tireSize1.trim(),
        tireSize2: form.tireSize2.trim() || null,
      });
      showToast(`vehicle:${Date.now()}`, '', 'Vehicle added', owner.id === customer.id ? '' : `to ${contactDisplayName(owner)}`);
      if (formOnly) return onClose();
      setAdding(false);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(v: Vehicle) {
    if (!window.confirm(`Delete ${vehicleTitle(v) || v.plateNumber || 'this vehicle'}?`)) return;
    try {
      await deleteVehicle(v.id);
      setVehicles((list) => list?.filter((x) => x.id !== v.id) ?? null);
    } catch (err) {
      showToast(`vehicle-delete:${v.id}`, '', "Couldn't delete the vehicle", (err as Error).message);
    }
  }

  if (typeof document === 'undefined') return null;
  const field = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-hidden focus:border-primary focus:ring-1 focus:ring-primary';
  const label = 'block text-[11px] font-semibold text-muted';
  const optional = <span className="font-normal text-faint">(optional)</span>;
  const required = <span className="text-danger">*</span>;
  // A required field left empty (after Add vehicle was pressed): red border and the reason under it
  const bad = (k: keyof typeof problems) => (touched && problems[k] ? 'border-danger' : '');
  const err = (k: keyof typeof problems) => (touched && problems[k] ? <p className="mt-1 text-[11px] text-danger">{problems[k]}</p> : null);

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-shadow/40 p-4 sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={adding ? 'Add vehicle' : 'Vehicles'} className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-surface shadow-xl">
        <div className="flex items-center gap-3 border-b border-line-soft px-5 py-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
            <CarIcon className="w-7" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-bold text-ink">{adding ? 'Add vehicle' : 'Vehicles'}</h2>
            <p className="truncate text-xs text-muted">{contactDisplayName(customer)}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="rounded-full p-1.5 text-faint hover:bg-surface-strong hover:text-body disabled:opacity-50">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {adding ? (
          <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
            <div className="grid min-h-0 flex-1 grid-cols-2 gap-x-3 gap-y-3 overflow-y-auto px-5 py-4">
              <div className="col-span-2">
                <span className={label}>CRM Customer {required}</span>
                {formOnly ? (
                  <p className="mt-1 truncate rounded-lg border border-line bg-surface-muted px-3 py-2 text-[13px] text-ink">
                    {contactDisplayName(customer)}
                    {customer.name && <span className="text-faint"> · +{customer.waId}</span>}
                  </p>
                ) : (
                  <CustomerPicker value={owner} onChange={setOwner} invalid={touched && !!problems.owner} />
                )}
                {touched && problems.owner && <p className="mt-1 text-[11px] text-danger">{problems.owner}</p>}
              </div>
              <div className="col-span-2 sm:col-span-1">
                <label htmlFor="v-plate" className={label}>Plate Number {required}</label>
                <input id="v-plate" value={form.plateNumber} onChange={set('plateNumber')} maxLength={20} placeholder="e.g. A 12345" aria-invalid={touched && !!problems.plateNumber} className={`${field} mt-1 uppercase placeholder:normal-case ${bad('plateNumber')}`} />
                {err('plateNumber')}
              </div>
              <div className="col-span-2 sm:col-span-1">
                <label htmlFor="v-year" className={label}>Year {required}</label>
                <input id="v-year" value={form.year} onChange={set('year')} inputMode="numeric" maxLength={4} placeholder="e.g. 2022" aria-invalid={touched && !!problems.year} className={`${field} mt-1 ${bad('year')}`} />
                {err('year')}
              </div>
              <div className="col-span-2 sm:col-span-1">
                <label htmlFor="v-make" className={label}>Make {required}</label>
                <input id="v-make" value={form.make} onChange={set('make')} maxLength={60} placeholder="e.g. Toyota" aria-invalid={touched && !!problems.make} className={`${field} mt-1 ${bad('make')}`} />
                {err('make')}
              </div>
              <div className="col-span-2 sm:col-span-1">
                <label htmlFor="v-model" className={label}>Model {required}</label>
                <input id="v-model" value={form.model} onChange={set('model')} maxLength={60} placeholder="e.g. Land Cruiser" aria-invalid={touched && !!problems.model} className={`${field} mt-1 ${bad('model')}`} />
                {err('model')}
              </div>
              <div className="col-span-2 sm:col-span-1">
                <label htmlFor="v-reg" className={label}>Registration Date {optional}</label>
                <input id="v-reg" type="date" max={today()} value={form.registrationDate} onChange={set('registrationDate')} className={`${field} mt-1`} />
              </div>
              <div className="col-span-2 sm:col-span-1">
                <label htmlFor="v-service" className={label}>Last Purchase / Service Date {optional}</label>
                <input id="v-service" type="date" max={today()} value={form.lastServiceDate} onChange={set('lastServiceDate')} className={`${field} mt-1`} />
              </div>
              <div className="col-span-2 sm:col-span-1">
                <label htmlFor="v-tire1" className={label}>Tire Size 1 {required}</label>
                <input id="v-tire1" value={form.tireSize1} onChange={set('tireSize1')} maxLength={30} placeholder="e.g. 265/65 R17" aria-invalid={touched && !!problems.tireSize1} className={`${field} mt-1 ${bad('tireSize1')}`} />
                {err('tireSize1')}
              </div>
              <div className="col-span-2 sm:col-span-1">
                <label htmlFor="v-tire2" className={label}>Tire Size 2 {optional}</label>
                <input id="v-tire2" value={form.tireSize2} onChange={set('tireSize2')} maxLength={30} placeholder="Rear, if different" className={`${field} mt-1`} />
              </div>
              {error && <p className="col-span-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-line-soft px-5 py-3">
              <button type="button" disabled={busy} onClick={() => (formOnly ? onClose() : setAdding(false))} className="rounded-lg px-3 py-1.5 text-xs font-medium text-body-soft hover:bg-surface-strong disabled:opacity-50">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="rounded-lg bg-primary px-4 py-1.5 text-xs font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50">
                {busy ? 'Saving…' : 'Add vehicle'}
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {vehicles === null ? (
                <p className="py-6 text-center text-xs text-muted">Loading…</p>
              ) : vehicles.length === 0 ? (
                <div className="py-6 text-center">
                  <p className="text-xs text-muted">{error || 'No vehicles yet.'}</p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {vehicles.map((v) => (
                    <li key={v.id} className="group rounded-xl border border-line px-3.5 py-3">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-semibold text-ink">{vehicleTitle(v) || 'Vehicle'}</p>
                          {v.plateNumber && <p className="mt-0.5 inline-block rounded border border-line bg-surface-muted px-1.5 text-[11px] font-semibold tracking-wide text-body">{v.plateNumber}</p>}
                        </div>
                        <button type="button" onClick={() => remove(v)} title="Delete vehicle" aria-label="Delete vehicle" className="rounded-full p-1 text-faint opacity-0 transition hover:bg-danger-soft hover:text-danger group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100">
                          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                          </svg>
                        </button>
                      </div>
                      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                        <dt className="text-faint">Tire size 1</dt>
                        <dd className="font-medium text-body">{v.tireSize1}</dd>
                        {v.tireSize2 && (
                          <>
                            <dt className="text-faint">Tire size 2</dt>
                            <dd className="font-medium text-body">{v.tireSize2}</dd>
                          </>
                        )}
                        {v.registrationDate && (
                          <>
                            <dt className="text-faint">Registered</dt>
                            <dd className="text-body">{showDay(v.registrationDate)}</dd>
                          </>
                        )}
                        {v.lastServiceDate && (
                          <>
                            <dt className="text-faint">Last purchase / service</dt>
                            <dd className="text-body">{showDay(v.lastServiceDate)}</dd>
                          </>
                        )}
                      </dl>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex justify-end border-t border-line-soft px-5 py-3">
              <button type="button" onClick={openForm} className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-semibold text-on-primary hover:bg-primary-hover">
                <span aria-hidden="true">+</span> Add vehicle
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

// "CRM Customer": the chosen contact; type a name or number to search the CRM (↑ ↓ Enter, Esc)
function CustomerPicker({ value, onChange, invalid }: { value: VehicleCustomer | null; onChange: (c: VehicleCustomer | null) => void; invalid: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<VehicleCustomer[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setLoading(true);
    const t = setTimeout(() => {
      searchVehicleCustomers(query)
        .then((r) => !stale && (setResults(r), setActive(0)))
        .catch(() => !stale && setResults([]))
        .finally(() => !stale && setLoading(false));
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  function choose(c: VehicleCustomer) {
    onChange(c);
    setOpen(false);
    setQuery('');
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[active]) choose(results[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div ref={ref} className="relative mt-1">
      {open ? (
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search name or number"
          aria-label="Search CRM customers"
          className="w-full rounded-lg border border-primary bg-surface px-3 py-2 text-[13px] text-ink outline-hidden ring-1 ring-primary"
        />
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-invalid={invalid}
          className={`flex w-full items-center gap-2 rounded-lg border bg-surface px-3 py-2 text-left text-[13px] ${invalid ? 'border-danger' : 'border-line hover:border-body-soft'}`}
        >
          <span className={`min-w-0 flex-1 truncate ${value ? 'text-ink' : 'text-faint'}`}>
            {value ? (
              <>
                {contactDisplayName(value)}
                {value.name && <span className="text-faint"> · +{value.waId}</span>}
              </>
            ) : (
              'Choose a customer'
            )}
          </span>
          <svg className="h-3.5 w-3.5 shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      )}
      {open && (
        <ul role="listbox" aria-label="CRM customers" className="absolute left-0 right-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-xl border border-line bg-surface p-1 text-[13px] shadow-xl">
          {results.map((c, i) => (
            <li key={c.id} role="option" aria-selected={value?.id === c.id}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(c)}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left ${i === active ? 'bg-surface-muted' : ''} ${value?.id === c.id ? 'text-primary' : 'text-ink'}`}
              >
                <span className="min-w-0 flex-1 truncate">{contactDisplayName(c)}</span>
                {c.name && <span className="shrink-0 text-[11px] text-faint">+{c.waId}</span>}
              </button>
            </li>
          ))}
          {!results.length && <li className="px-2.5 py-3 text-center text-xs text-muted">{loading ? 'Searching…' : 'No customers found'}</li>}
        </ul>
      )}
    </div>
  );
}
