'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { type DeletedContact, daysLeft, fetchDeletedContacts, profileName, restoreContact } from '@/lib/contacts';
import { isAdminRole } from '@/lib/roles';
import { formatDateTime } from '@/lib/time';
import { showToast } from '@/lib/toasts';
import { AppShell, type Me } from '../../AppShell';
import { SettingsShell } from '../SettingsShell';
import { TableSkeleton } from '../Skeleton';

// Settings → Contacts and data → Recently deleted contacts (owners/admins): contacts deleted from the contact page,
// kept for the retention period the server sets (14 days) and then removed for good with their chat. Restore brings
// the contact and its chat back as they were.
export default function DeletedContactsPage() {
  return (
    <AppShell>
      {(me) => (
        <SettingsShell me={me} section="Contacts and data" title="Recently deleted contacts">
          <Deleted me={me} />
        </SettingsShell>
      )}
    </AppShell>
  );
}

function Deleted({ me }: { me: Me }) {
  const router = useRouter();
  const admin = isAdminRole(me.role);
  const [rows, setRows] = useState<DeletedContact[] | null>(null);
  const [days, setDays] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const load = () =>
    fetchDeletedContacts()
      .then((r) => {
        setRows(r.deletedContacts);
        setDays(r.deletedContactsRetentionDays);
      })
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    if (!admin) router.replace('/settings');
    else load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admin]);
  if (!admin) return null;

  async function restore(c: DeletedContact) {
    setBusy(c.id);
    setError('');
    try {
      await restoreContact(c.id);
      showToast(`restore:${Date.now()}`, '', `${name(c)} restored, with their chat.`, 'Recently deleted contacts');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const name = (c: DeletedContact) => profileName(c);

  return (
    <div className="max-w-6xl">
      <p className="text-[13px] text-body-soft">
        {days === null ? '…' : `Contacts will be permanently deleted and unable to be restored after ${days} days since their initial deletion have passed.`}
      </p>
      {error && <p className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
      {rows === null ? (
        !error && <TableSkeleton rows={3} />
      ) : rows.length === 0 ? (
        <div className="mt-12 flex flex-col items-center text-center">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-strong text-body-soft">
            <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
              <path d="M14 3v5h5" />
              <circle cx="11.5" cy="13.5" r="2.5" />
              <path d="m13.5 15.5 2 2" />
            </svg>
          </span>
          <p className="mt-3 text-[14px] font-semibold text-ink">No contacts here</p>
          <p className="mt-1 text-[12px] text-body-soft">Deleted contacts will appear here before they are permanently removed.</p>
        </div>
      ) : (
        <div className="mt-5 overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-left text-[13px]" aria-label="Recently deleted contacts">
            <thead>
              <tr className="border-b border-line bg-surface-muted text-[12px] font-semibold text-ink">
                <th className="px-4 py-3">Contact</th>
                <th className="px-4 py-3">Phone number</th>
                <th className="px-4 py-3">Deleted by</th>
                <th className="px-4 py-3">Deleted on</th>
                <th className="px-4 py-3">Permanently deleted in</th>
                <th className="w-32 px-4 py-3" aria-label="Actions" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {rows.map((c) => {
                const left = daysLeft(c.purgeAt);
                return (
                  <tr key={c.id}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink">{name(c)}</p>
                      {c.email && <p className="text-[11px] text-muted">{c.email}</p>}
                    </td>
                    <td className="px-4 py-3 text-body">+{c.waId}</td>
                    <td className="px-4 py-3 text-body">{c.deletedByName ?? '—'}</td>
                    <td className="px-4 py-3 text-body">{formatDateTime(c.deletedAt)}</td>
                    <td className={`px-4 py-3 ${left <= 2 ? 'font-medium text-danger' : 'text-body'}`} title={`On ${formatDateTime(c.purgeAt)}`}>
                      {left === 0 ? 'Today' : `${left} ${left === 1 ? 'day' : 'days'}`}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() => restore(c)}
                        aria-label={`Restore ${name(c)}`}
                        className="rounded-lg border border-primary px-4 py-1.5 text-[12px] font-semibold text-primary transition hover:bg-primary/5 disabled:opacity-50"
                      >
                        {busy === c.id ? 'Restoring…' : 'Restore'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
