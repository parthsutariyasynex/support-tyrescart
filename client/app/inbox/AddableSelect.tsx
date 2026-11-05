'use client';

import { useEffect, useRef, useState } from 'react';
import { errorCode } from '@/lib/api';
import { showToast } from '@/lib/toasts';
import { VehicleSelect, type VehicleSelectOption } from './VehicleSelect';

// A vehicle form field: the searchable dropdown (VehicleSelect) with "+ Add New …" at the bottom. That swaps the
// dropdown for a textbox in the same spot (nothing below moves); Add checks and saves the value through the API
// (onAdd), and the field chooses it. One already listed (any case or spacing) is chosen instead of added twice.
// One message slot under the field, in the row gap like the form's other errors: the add step's error, else the form's.
export function AddableSelect({
  id,
  label,
  required,
  value,
  onChange,
  options,
  loadError,
  error,
  placeholder,
  disabled,
  disabledHint,
  autoFocus,
  withLogo,
  numeric,
  addNewLabel,
  addPlaceholder,
  addMaxLength = 60,
  uppercase,
  canAdd = true,
  check,
  onAdd,
  onDuplicate,
}: {
  id: string;
  label: string;
  required?: boolean;
  value: string;
  onChange: (value: string) => void;
  options: VehicleSelectOption[] | null; // null while loading
  loadError?: string;
  error?: string;
  placeholder: string;
  disabled?: boolean;
  disabledHint?: string;
  autoFocus?: boolean;
  withLogo?: boolean;
  numeric?: boolean; // years: digits only
  addNewLabel: string; // "+ Add New Make"
  addPlaceholder: string; // "e.g. Foton"
  addMaxLength?: number;
  uppercase?: boolean; // tyre sizes are saved in capitals
  canAdd?: boolean; // false: no "+ Add New …" row (e.g. every year is already offered)
  check?: (draft: string) => string | null; // quick check before asking the server (it checks again)
  onAdd: (draft: string) => Promise<string>; // saves; resolves to the value as saved
  onDuplicate?: (existing: string) => void; // someone added it meanwhile: make sure the list shows it
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const select = useRef<HTMLDivElement>(null);
  const noun = label.toLowerCase();

  useEffect(() => {
    if (adding) input.current?.focus();
  }, [adding]);
  // The field above changed (e.g. another make): an add step for the old one no longer applies
  useEffect(() => {
    if (disabled) setAdding(false);
  }, [disabled]);

  const focusSelect = () => setTimeout(() => select.current?.querySelector('button')?.focus(), 0);
  const startAdding = (query: string) => {
    setDraft(numeric ? query.replace(/\D/g, '').slice(0, 4) : query.slice(0, addMaxLength));
    setAddError('');
    setAdding(true);
  };
  const stopAdding = () => {
    setAdding(false);
    setAddError('');
    focusSelect();
  };
  const same = (a: string, b: string) => a.replace(/\s+/g, '').toLowerCase() === b.replace(/\s+/g, '').toLowerCase();
  const chooseExisting = (existing: string) => {
    onChange(existing);
    setAdding(false);
    setAddError('');
    focusSelect();
    showToast(`vehicle-list:${Date.now()}`, '', `${existing} is already in the list. Selected it.`);
  };

  async function add() {
    const text = draft.trim().replace(/\s+/g, ' ');
    if (busy) return;
    if (!text) return setAddError(`Enter a ${noun}`);
    const problem = check?.(text);
    if (problem) return setAddError(problem);
    const listed = options?.find((o) => same(o.value, text));
    if (listed) return chooseExisting(listed.value);
    setBusy(true);
    setAddError('');
    try {
      const saved = await onAdd(text);
      onChange(saved);
      setAdding(false);
      focusSelect();
      showToast(`vehicle-list:${Date.now()}`, '', `${label} ${saved} added`);
    } catch (err) {
      // Added by someone else meanwhile: the message names it as listed ("Foton is already in the list")
      if (errorCode(err) === 'DUPLICATE') {
        const existing = /^(.+) is already in the list$/.exec((err as Error).message)?.[1] ?? text;
        onDuplicate?.(existing);
        chooseExisting(existing);
      } else setAddError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const message = addError || error;
  return (
    <div className="relative">
      <label htmlFor={adding ? `${id}-new` : id} className="mb-1.5 block truncate text-[11px] font-semibold text-body-soft">
        {label}
        {required && <span className="text-danger"> *</span>}
      </label>
      {adding ? (
        <div className="flex gap-1.5">
          <input
            ref={input}
            id={`${id}-new`}
            value={draft}
            onChange={(e) => {
              setDraft(numeric ? e.target.value.replace(/\D/g, '').slice(0, 4) : e.target.value.slice(0, addMaxLength));
              setAddError('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault(); // not the vehicle form's submit
                void add();
              } else if (e.key === 'Escape') {
                // Only the add step closes, not the dialog
                e.preventDefault();
                e.stopPropagation();
                if (!busy) stopAdding();
              }
            }}
            disabled={busy}
            autoComplete="off"
            inputMode={numeric ? 'numeric' : undefined}
            maxLength={numeric ? 4 : addMaxLength}
            placeholder={addPlaceholder}
            aria-invalid={!!addError}
            aria-label={`New ${noun}`}
            className={`h-[38px] min-w-0 flex-1 rounded-lg border bg-surface px-3 text-[13px] text-ink outline-hidden placeholder:normal-case placeholder:text-faint focus:ring-1 disabled:opacity-60 ${uppercase ? 'uppercase' : ''} ${
              addError ? 'border-danger focus:border-danger focus:ring-danger' : 'border-line focus:border-primary focus:ring-primary'
            }`}
          />
          <button
            type="button"
            onClick={() => void add()}
            disabled={busy}
            className="h-[38px] shrink-0 rounded-lg bg-primary px-3 text-[12px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
          >
            {busy ? 'Adding…' : 'Add'}
          </button>
          <button
            type="button"
            onClick={stopAdding}
            disabled={busy}
            aria-label={`Cancel adding a ${noun}`}
            title="Cancel"
            className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-lg border border-line text-body-soft hover:bg-surface-muted disabled:opacity-50"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      ) : (
        <div ref={select}>
          <VehicleSelect
            id={id}
            label={label}
            value={value}
            options={options}
            loadError={loadError}
            onChange={onChange}
            placeholder={placeholder}
            disabled={disabled}
            disabledHint={disabledHint}
            invalid={!!error}
            autoFocus={autoFocus}
            withLogo={withLogo}
            numeric={numeric}
            addNewLabel={canAdd ? addNewLabel : undefined}
            onAddNew={canAdd ? startAdding : undefined}
          />
        </div>
      )}
      {message && <p className="absolute inset-x-0 top-full mt-0.5 truncate text-[11px] leading-4 text-danger">{message}</p>}
    </div>
  );
}
