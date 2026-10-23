'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { updateContact } from '@/lib/contacts';
import { contactCountry, filterDialCountries, phoneCountries } from '@/lib/profileOptions';
import { showToast } from '@/lib/toasts';

const WIDTH = 288; // the dropdown's width (w-72)
const NOT_SET = '';

type Item = { value: string; label: string; dial: string; flag: string; name: string };

// Chat header (right, beside Labels): the customer's country as flag and calling code ("🇮🇳 +91 ⌄"), from their
// profile or else their number.
// Opened: search by code or name (↑ ↓ Enter, Esc) and pick one; it's saved as the customer's Country (live for
// everyone). "Not set" goes back to the number's own country.
export function CountryCodeMenu({ contactId, country, waId }: { contactId: string; country?: string | null; waId: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const current = contactCountry(country, waId);
  const fromNumber = contactCountry(null, waId);
  const selectedValue = country?.trim() || NOT_SET;
  const items = useMemo<Item[]>(
    () => [
      { value: NOT_SET, label: 'Not set', dial: '', flag: '', name: 'Not set' },
      ...phoneCountries().map((c) => ({ value: c.name, label: `+${c.dial} ${c.name}`, dial: c.dial, flag: c.flag, name: c.name })),
    ],
    [],
  );
  // "Not set" only without a search; a search lists countries
  const shown = !open ? [] : query.trim() ? filterDialCountries(items.slice(1), query) : items;

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(Math.max(0, items.findIndex((i) => i.value === selectedValue)));
    // Drawn on <body>, just under the button with right edges lined up (it sits on the right of the header), inside the window
    const r = buttonRef.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.max(8, Math.min(r.right - WIDTH, window.innerWidth - WIDTH - 8)), top: r.bottom + 6 });
    const onPointer = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!buttonRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => setActive(0), [query]);
  // The highlighted row stays in view (opening scrolls to the current country)
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, pos]);

  async function choose(value: string) {
    setOpen(false);
    buttonRef.current?.focus();
    if (value === selectedValue) return;
    setBusy(true);
    try {
      await updateContact(contactId, { country: value }); // the header follows via contact:updated
    } catch (e) {
      showToast(`country:${contactId}:${Date.now()}`, '', "Couldn't change the country", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[active]) choose(shown[active].value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    }
  }

  const label = current ? (current.dial ? `+${current.dial}` : current.name) : 'Country';
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={current ? `Country code ${label}, ${current.name}. Change` : 'Set country'}
        title={current ? `${current.name} (${label})` : 'Set country'}
        className={`flex max-w-40 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium tabular-nums transition disabled:opacity-60 ${
          open ? 'border-primary text-primary' : 'border-line text-body-soft hover:bg-surface-strong hover:text-body'
        }`}
      >
        {current?.flag ? (
          <span className="text-[13px] leading-none" aria-hidden="true">
            {current.flag}
          </span>
        ) : (
          <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
        )}
        <span className="truncate">{label}</span>
        <svg className={`h-3 w-3 text-faint transition-transform ${open ? 'rotate-180 text-primary' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label="Country code"
            onKeyDown={onKeyDown}
            style={{ left: pos.left, top: pos.top, width: WIDTH }}
            className="fixed z-[70] flex flex-col overflow-hidden rounded-2xl border border-line bg-surface text-xs shadow-xl"
          >
            <div className="px-3.5 pb-2 pt-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-faint">Country code</p>
              <p className="mt-0.5 truncate text-[12px] text-body-soft">
                {country?.trim() ? (
                  <>
                    Set to <span className="font-semibold text-ink">{current?.flag} {current?.name}</span>
                  </>
                ) : fromNumber ? (
                  <>
                    From the number: <span className="font-semibold text-ink">{fromNumber.flag} {fromNumber.name}</span>
                  </>
                ) : (
                  'Not set'
                )}
              </p>
            </div>
            <div className="px-2.5 pb-2">
              <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-muted/60 px-2.5 py-1.5 focus-within:border-primary focus-within:bg-surface">
                <svg className="h-3.5 w-3.5 shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <input
                  autoFocus
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search +971 or country"
                  aria-label="Search code or country"
                  className="w-full bg-transparent text-[12px] text-ink outline-hidden placeholder:text-faint"
                />
              </div>
            </div>
            <ul ref={listRef} role="listbox" aria-label="Countries" className="max-h-72 overflow-y-auto border-t border-line-soft px-1.5 py-1.5">
              {shown.map((o, i) => {
                const selected = o.value === selectedValue;
                return (
                  <li key={o.value || 'not-set'} role="option" aria-selected={selected} data-index={i}>
                    <button
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(o.value)}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition ${i === active ? 'bg-surface-muted' : ''} ${
                        selected ? 'text-primary' : 'text-ink'
                      } ${o.value === NOT_SET ? 'mb-1' : ''}`}
                    >
                      {o.value === NOT_SET ? (
                        <span className="min-w-0 flex-1 truncate text-body-soft">
                          Not set{fromNumber?.dial ? <span className="text-faint">{` · use the number's +${fromNumber.dial}`}</span> : null}
                        </span>
                      ) : (
                        <>
                          <span className="w-5 shrink-0 text-center text-[15px] leading-none" aria-hidden="true">
                            {o.flag}
                          </span>
                          <span className={`w-11 shrink-0 font-semibold tabular-nums ${selected ? 'text-primary' : 'text-muted'}`}>+{o.dial}</span>
                          <span className={`min-w-0 flex-1 truncate ${selected ? 'font-semibold' : ''}`}>{o.name}</span>
                        </>
                      )}
                      {selected && (
                        <svg className="h-3.5 w-3.5 shrink-0 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      )}
                    </button>
                  </li>
                );
              })}
              {!shown.length && <li className="px-2.5 py-4 text-center text-muted">No country matches “{query.trim()}”</li>}
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
}
