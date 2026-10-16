'use client';

import { useEffect, useRef, useState } from 'react';
import {
  type ContactList,
  type ContactListRef,
  addContactToList,
  createContactList,
  deleteContactList,
  fetchContactLists,
  removeContactFromList,
  searchLists,
  upsertList,
} from '@/lib/contactLists';
import { showToast } from '@/lib/toasts';

// Live list changes from the inbox page's socket (contactList:saved / contactList:deleted), as window events
export const CONTACT_LIST_SAVED_EVENT = 'app:contact-list-saved';
export const CONTACT_LIST_DELETED_EVENT = 'app:contact-list-deleted';

// Profile panel "Lists +": search, tick lists on/off for this customer, create a list by typing a new name.
// Owners/admins also get a delete button on each list.
export function ListsDropdown({
  contactId,
  conversationId,
  contactName,
  memberOf,
  canDelete,
  onChanged,
  onClose,
}: {
  contactId: string;
  conversationId: string;
  contactName: string;
  memberOf: ContactListRef[];
  canDelete: boolean;
  onChanged: (lists: ContactListRef[]) => void;
  onClose: () => void;
}) {
  const [lists, setLists] = useState<ContactList[] | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ id: string; checked: boolean } | null>(null);
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    fetchContactLists()
      .then(setLists)
      .catch((e) => setError((e as Error).message));
    const onPointer = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!ref.current?.contains(t) && !t.closest('[data-lists-toggle]')) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onSaved = (e: Event) => setLists((prev) => (prev ? upsertList(prev, (e as CustomEvent<ContactList>).detail) : prev));
    const onDeleted = (e: Event) => setLists((prev) => prev?.filter((l) => l.id !== (e as CustomEvent<{ id: string }>).detail.id) ?? prev);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    window.addEventListener(CONTACT_LIST_SAVED_EVENT, onSaved);
    window.addEventListener(CONTACT_LIST_DELETED_EVENT, onDeleted);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener(CONTACT_LIST_SAVED_EVENT, onSaved);
      window.removeEventListener(CONTACT_LIST_DELETED_EVENT, onDeleted);
    };
  }, [onClose]);

  const inList = new Set(memberOf.map((l) => l.id));
  const { shown, canCreate, name } = searchLists(lists ?? [], query);

  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const toggle = (l: ContactList) => {
    const removing = inList.has(l.id);
    setPending({ id: l.id, checked: !removing });
    return run(async () => {
      onChanged(removing ? await removeContactFromList(contactId, l.id) : await addContactToList(contactId, l.id));
      showToast(`list:${l.id}:${Date.now()}`, conversationId, removing ? `Removed from the list "${l.name}".` : `Added to the list "${l.name}".`, contactName);
    });
  };

  const create = () =>
    run(async () => {
      const list = await createContactList(name);
      setLists((prev) => upsertList(prev ?? [], list));
      onChanged(await addContactToList(contactId, list.id)); // a list made from here includes this customer
      setQuery('');
      showToast(`list:new:${list.id}`, conversationId, `List "${list.name}" created and this customer added.`, contactName);
    });

  const remove = (l: ContactList) => {
    if (!confirm(`Delete the list "${l.name}"? ${l.contactCount === 1 ? '1 customer is' : `${l.contactCount} customers are`} in it. The customers themselves are not deleted.`)) return;
    return run(async () => {
      await deleteContactList(l.id);
      setLists((prev) => prev?.filter((x) => x.id !== l.id) ?? prev);
      onChanged(memberOf.filter((x) => x.id !== l.id));
      showToast(`list:del:${l.id}`, conversationId, `List "${l.name}" deleted.`, '');
    });
  };

  return (
    <div ref={ref} role="dialog" aria-label="Lists" className="absolute inset-x-3 top-full z-30 mt-1 flex max-h-[420px] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xl">
      <div className="p-3 pb-2">
        <div className="flex items-center gap-2 rounded-lg border border-primary px-3 py-2 ring-1 ring-primary">
          <svg className="h-4 w-4 shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canCreate) create();
            }}
            aria-label="Search lists"
            placeholder="Search or create a list"
            className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
          />
        </div>
      </div>
      {error && <p className="mx-3 mb-2 rounded-lg bg-danger-soft px-2.5 py-1.5 text-xs text-danger">{error}</p>}
      <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
        {lists === null && !error && <li className="px-3 py-3 text-xs text-faint">Loading…</li>}
        {shown.map((l) => {
          const checked = pending?.id === l.id ? pending.checked : inList.has(l.id);
          return (
            <li key={l.id} className="group flex items-center rounded-lg hover:bg-surface-muted">
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-2.5 py-2">
                <input type="checkbox" checked={checked} onChange={() => toggle(l)} aria-label={l.name} className="h-4 w-4 shrink-0 cursor-pointer rounded border-line-strong accent-primary" />
                <span className="truncate text-[13px] text-body">{l.name}</span>
                <span className="shrink-0 text-[11px] text-faint">{l.contactCount}</span>
              </label>
              {canDelete && (
                <button
                  type="button"
                  onClick={() => remove(l)}
                  title={`Delete list ${l.name}`}
                  aria-label={`Delete list ${l.name}`}
                  className="mr-1.5 rounded-md p-1 text-faint opacity-0 transition hover:bg-danger-soft hover:text-danger group-hover:opacity-100 focus:opacity-100"
                >
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
                  </svg>
                </button>
              )}
            </li>
          );
        })}
        {lists !== null && shown.length === 0 && !canCreate && <li className="px-3 py-4 text-center text-xs text-muted">{query.trim() ? 'No list matches' : 'No lists yet. Type a name to create one.'}</li>}
        {canCreate && (
          <li>
            <button type="button" disabled={busy} onClick={create} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-primary hover:bg-surface-muted disabled:opacity-60">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span className="truncate">Create list “{name}”</span>
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
