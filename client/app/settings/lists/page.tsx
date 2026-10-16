'use client';

import { useCallback, useEffect, useState } from 'react';
import { type ContactList, createContactList, deleteContactList, fetchContactLists } from '@/lib/contactLists';
import { isAdminRole } from '@/lib/roles';
import { showToast } from '@/lib/toasts';
import { AppShell, type Me } from '../../AppShell';
import { inputClass } from '../../AuthShell';
import { SettingsShell } from '../SettingsShell';
import { TableSkeleton } from '../Skeleton';

// Settings → Contact lists: every list and how many customers are in it; create one (everyone), delete one (owners
// and admins; the customers themselves stay). Customers are added to lists from a chat's profile panel.
export default function ListsSettingsPage() {
  return (
    <AppShell>
      {(me) => (
        <SettingsShell me={me} section="Contacts and data" title="Contact lists">
          <Lists me={me} />
        </SettingsShell>
      )}
    </AppShell>
  );
}

function Lists({ me }: { me: Me }) {
  const [lists, setLists] = useState<ContactList[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const canDelete = isAdminRole(me.role);
  const load = useCallback(() => fetchContactLists().then(setLists).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    load();
  }, [load]);
  async function run(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
      showToast(`lists:${Date.now()}`, '', message, '');
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="max-w-3xl">
      <p className="text-xs text-muted">Add customers to lists from the Lists section of a chat's profile panel.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (name.trim() && (await run(() => createContactList(name.trim()), `List "${name.trim()}" created.`))) setName('');
        }}
        className="mt-4 flex gap-2"
      >
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="New list name, e.g. VIP customers" aria-label="New list name" className={`${inputClass} max-w-sm`} />
        <button type="submit" disabled={!name.trim() || busy} className="shrink-0 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50">
          Create list
        </button>
      </form>
      {error && <p className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
      {lists === null ? (
        <TableSkeleton rows={4} />
      ) : lists.length === 0 ? (
        <p className="mt-6 text-sm text-muted">No lists yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-line-soft rounded-xl border border-line bg-surface">
          {lists.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium text-ink">{l.name}</span>
                <span className="text-[11px] text-muted">
                  {l.contactCount} {l.contactCount === 1 ? 'customer' : 'customers'}
                </span>
              </span>
              {canDelete && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => confirm(`Delete the list "${l.name}"? The customers in it are not deleted.`) && run(() => deleteContactList(l.id), `List "${l.name}" deleted.`)}
                  className="shrink-0 rounded-md px-2 py-1 text-xs text-body-soft hover:bg-danger-soft hover:text-danger"
                >
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
