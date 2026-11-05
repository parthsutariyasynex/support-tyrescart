'use client';

import { useEffect, useRef, useState } from 'react';

export type VehicleSelectOption = { value: string; label: string; logo?: string | null };

// The vehicle form's Make / Model / Year dropdown: sized like the form's inputs. Opened: type to filter, ↑ ↓ Enter to
// choose, Esc or a click outside to close. When the search matches nothing listed, "Use “…”" keeps what was typed
// (a vehicle the list doesn't have, or the list couldn't load). options = null while loading.
// With onAddNew (tyre sizes), there's no "Use “…”": a "+ Add New …" row pinned at the bottom hands over to the caller's
// own add step instead (with whatever was searched), so new values are checked and saved before they can be chosen.
export function VehicleSelect({
  id,
  label,
  value,
  options,
  onChange,
  placeholder,
  disabled,
  disabledHint,
  invalid,
  loadError,
  numeric,
  withLogo,
  autoFocus,
  addNewLabel,
  onAddNew,
}: {
  id: string;
  label: string;
  value: string;
  options: VehicleSelectOption[] | null;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
  disabledHint?: string; // shown instead of the placeholder while disabled, e.g. "Choose a make first"
  invalid?: boolean;
  loadError?: string;
  numeric?: boolean; // years: the search box brings up the number pad, custom values are 4 digits
  withLogo?: boolean; // options have logos (makes): reserve the logo's room while loading
  autoFocus?: boolean;
  addNewLabel?: string; // e.g. "+ Add New Tyre Size"
  onAddNew?: (query: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const q = query.trim().toLowerCase();
  const all = options ?? [];
  // Spaces and punctuation don't matter: "205 55 16" finds 205/55R16, "landrover" finds Land Rover
  const loose = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
  const lq = loose(q);
  const matches = q ? all.filter((o) => o.label.toLowerCase().includes(q) || (!!lq && loose(o.label).includes(lq))) : all;
  // Starts-with first: typing "to" puts Toyota above Mitsubishi Outlander-style matches
  if (q) matches.sort((a, b) => Number(!a.label.toLowerCase().startsWith(q)) - Number(!b.label.toLowerCase().startsWith(q)));
  const exact = all.some((o) => o.label.toLowerCase() === q);
  const custom = !onAddNew && query.trim() && !exact && (!numeric || /^\d{4}$/.test(query.trim())) ? query.trim() : '';
  const rows: { value: string; label: string; logo?: string | null; custom?: boolean }[] = [...matches, ...(custom ? [{ value: custom, label: `Use “${custom}”`, custom: true }] : [])];
  const addIndex = onAddNew ? rows.length : -1; // the pinned "+ Add New …" row comes after the list for ↑ ↓ and Enter
  const last = onAddNew ? rows.length : rows.length - 1;

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(Math.max(0, all.findIndex((o) => o.value.toLowerCase() === value.toLowerCase())));
    const onPointer = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const choose = (v: string) => {
    setOpen(false);
    button.current?.focus();
    if (v !== value) onChange(v);
  };
  const addNew = () => {
    setOpen(false);
    onAddNew?.(query.trim());
  };
  const current = all.find((o) => o.value.toLowerCase() === value.toLowerCase());

  return (
    <div ref={ref} className="relative">
      <button
        ref={button}
        id={id}
        type="button"
        autoFocus={autoFocus}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-invalid={invalid}
        aria-label={`${label}: ${value || 'not chosen'}`}
        className={`flex h-[38px] w-full items-center gap-2 rounded-lg border bg-surface px-3 text-left text-[13px] outline-hidden focus:ring-1 disabled:cursor-not-allowed disabled:bg-surface-muted ${
          invalid ? 'border-danger focus:border-danger focus:ring-danger' : 'border-line focus:border-primary focus:ring-primary'
        }`}
      >
        {/* While the list loads, a saved value keeps a logo-sized placeholder so its text doesn't jump when the logo arrives */}
        {current?.logo ? (
          <img src={current.logo} alt="" width={16} height={16} className="h-4 w-4 shrink-0 object-contain" />
        ) : (
          withLogo && value && options === null && <span className="h-4 w-4 shrink-0 animate-pulse rounded bg-surface-strong" aria-hidden="true" />
        )}
        <span className={`flex-1 truncate ${value ? 'text-ink' : 'text-faint'}`}>{value || (disabled && disabledHint) || placeholder}</span>
        {value && !disabled && (
          <span
            role="button"
            tabIndex={-1}
            aria-label={`Clear ${label.toLowerCase()}`}
            onClick={(e) => {
              e.stopPropagation();
              onChange('');
            }}
            className="-mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint hover:bg-surface-muted hover:text-body"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </span>
        )}
        <svg className={`h-4 w-4 shrink-0 text-body-soft transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-full min-w-[12rem] overflow-hidden rounded-xl border border-line bg-surface shadow-xl">
          <div className="border-b border-line-soft p-2">
            <input
              autoFocus
              type="search"
              inputMode={numeric ? 'numeric' : undefined}
              value={query}
              onChange={(e) => {
                setQuery(numeric ? e.target.value.replace(/\D/g, '').slice(0, 4) : e.target.value.slice(0, 60));
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, last));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  if (active === addIndex) addNew();
                  else if (rows[active]) choose(rows[active].value);
                } else if (e.key === 'Escape') {
                  // Only this dropdown closes, not the dialog it's in
                  e.preventDefault();
                  e.stopPropagation();
                  setOpen(false);
                  button.current?.focus();
                }
              }}
              placeholder={`Search ${label.toLowerCase()}`}
              aria-label={`Search ${label.toLowerCase()}`}
              className="h-8 w-full rounded-lg border border-line bg-surface-muted/60 px-2.5 text-[13px] text-ink outline-hidden placeholder:text-faint focus:border-primary focus:bg-surface"
            />
          </div>
          <ul ref={list} role="listbox" aria-label={label} className="max-h-60 overflow-y-auto py-1">
            {options === null && <li className="px-3 py-2.5 text-xs text-faint">Loading…</li>}
            {loadError && (
              <li className="px-3 py-2 text-[11px] text-danger">
                {loadError}
                {!onAddNew && ' You can still type a value above.'}
              </li>
            )}
            {rows.map((o, i) => {
              const selected = !o.custom && o.value.toLowerCase() === value.toLowerCase();
              return (
                <li key={`${o.custom ? 'custom:' : ''}${o.value}`} role="option" aria-selected={selected} data-index={i}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(o.value)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] ${i === active ? 'bg-surface-muted' : ''} ${selected ? 'font-medium text-primary' : o.custom ? 'italic text-body' : 'text-ink'}`}
                  >
                    {o.logo && <img src={o.logo} alt="" loading="lazy" width={16} height={16} className="h-4 w-4 shrink-0 object-contain" />}
                    <span className="flex-1 truncate">{o.label}</span>
                    {selected && (
                      <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    )}
                  </button>
                </li>
              );
            })}
            {options !== null && !rows.length && <li className="px-3 py-2.5 text-xs text-faint">{q ? 'No matches' : onAddNew ? 'Nothing listed yet' : 'Nothing listed. Type to add one.'}</li>}
          </ul>
          {onAddNew && (
            <button
              type="button"
              onMouseEnter={() => setActive(addIndex)}
              onClick={addNew}
              className={`flex w-full items-center gap-2 border-t border-line-soft px-3 py-2 text-left text-[13px] font-semibold text-primary ${active === addIndex ? 'bg-surface-muted' : ''}`}
            >
              {addNewLabel ?? '+ Add new'}
              {query.trim() && <span className="truncate font-normal text-muted">“{query.trim()}”</span>}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
