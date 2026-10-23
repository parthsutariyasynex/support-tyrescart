'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CountryCode } from 'libphonenumber-js';
import { type Conversation, startConversation } from '@/lib/inbox';
import { filterDialCountries, newChatNumber, phoneCountries } from '@/lib/profileOptions';
import { SearchSelect } from '../SearchSelect';

// "New chat": the customer's WhatsApp number (country code + number, checked as you go) and, for a new contact, an
// optional name. A number that already has a chat opens that chat (no second contact). The first message to a new
// number has to be an approved template: the chat opens on "Send template".
export function NewChatDialog({
  defaultCountry,
  onDone,
  onClose,
}: {
  defaultCountry: string;
  onDone: (conversation: Conversation, startedNow: boolean) => void;
  onClose: () => void;
}) {
  const countries = useMemo(() => phoneCountries().map((c) => ({ value: c.code, label: `+${c.dial} ${c.name}` })), []);
  const [country, setCountry] = useState<CountryCode>(() => (countries.some((c) => c.value === defaultCountry) ? defaultCountry : countries[0].value) as CountryCode);
  const [number, setNumber] = useState('');
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const numberRef = useRef<HTMLInputElement>(null);
  const checked = newChatNumber(country, number);

  useEffect(() => {
    numberRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if ('problem' in checked || busy) return;
    setBusy(true);
    setError('');
    try {
      const c = await startConversation(checked.waId, name.trim());
      onDone(c, c.startedNow);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (typeof document === 'undefined') return null;
  const field = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-hidden focus:border-primary focus:ring-1 focus:ring-primary';
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-shadow/40 p-4 sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form role="dialog" aria-modal="true" aria-label="New chat" onSubmit={submit} className="w-full max-w-md rounded-2xl bg-surface p-5 shadow-xl">
        <h2 className="text-sm font-bold text-ink">New chat</h2>
        <p className="mt-1 text-xs text-muted">The first message to a customer must be an approved WhatsApp template. You choose it next.</p>

        <label className="mt-4 block text-[11px] font-semibold text-muted">WhatsApp number</label>
        <div className="mt-1 grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-2">
          <SearchSelect label="Country code" value={country} options={countries} filter={filterDialCountries} onChange={(v) => setCountry(v as CountryCode)} placeholder="Search +971 or country" />
          <input
            ref={numberRef}
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            onBlur={() => setTouched(true)}
            inputMode="tel"
            autoComplete="tel"
            placeholder="Number"
            aria-label="Number"
            aria-invalid={touched && 'problem' in checked}
            className={field}
          />
        </div>
        {touched && 'problem' in checked && <p className="mt-1 text-[11px] text-danger">{checked.problem}</p>}

        <label htmlFor="new-chat-name" className="mt-3 block text-[11px] font-semibold text-muted">
          Name <span className="font-normal text-faint">(optional, for a new contact)</span>
        </label>
        <input id="new-chat-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={191} className={`${field} mt-1`} />

        {error && <p className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs font-medium text-body-soft hover:bg-surface-strong disabled:opacity-50">
            Cancel
          </button>
          <button type="submit" disabled={busy || 'problem' in checked} className="rounded-lg bg-primary px-4 py-1.5 text-xs font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50">
            {busy ? 'Opening…' : 'Start chat'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
