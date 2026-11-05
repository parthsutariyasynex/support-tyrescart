'use client';

import { useRouter } from 'next/navigation';
import { Fragment, useEffect, useState } from 'react';
import { isAdminRole } from '@/lib/roles';
import { type WhatsAppConnectionLog, type WhatsAppLogFilter, type WhatsAppLogOption, fetchWhatsAppConnectionLogs } from '@/lib/settings';
import { AppShell, type Me } from '../../AppShell';
import { SettingsShell } from '../SettingsShell';
import { TableSkeleton } from '../Skeleton';

// Settings → Company settings → WhatsApp connection activity (owners/admins): every Connect / Update / Replace attempt
// and restore, with who did it, the previous and new number, the 7 checks with Meta, the backup and the outcome.
// Times are in Dubai. Filters: workspace (those you're an admin of), admin, dates (Dubai days) and status.
export default function WhatsAppActivityPage() {
  return (
    <AppShell>
      {(me) => (
        <SettingsShell me={me} section="Company settings" title="WhatsApp connection activity">
          <Activity me={me} />
        </SettingsShell>
      )}
    </AppShell>
  );
}

const PAGE = 25;
const CHECK_NAMES = ['Access token', 'Meta app', 'Permanent token', 'Permissions', 'WhatsApp Business account', 'Phone number', 'Webhooks'];
const ACTIONS: Record<WhatsAppConnectionLog['action'], string> = { connect: 'Connected', replace: 'Replaced number', update: 'Updated', restore: 'Restored backup' };
const SOURCES: Record<WhatsAppConnectionLog['source'], string> = { settings: 'Settings', api: 'REST API', script: 'Command line' };
const dubai = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const select = 'rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary';

function Activity({ me }: { me: Me }) {
  const router = useRouter();
  const admin = isAdminRole(me.role);
  const [filter, setFilter] = useState<WhatsAppLogFilter>({});
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<WhatsAppConnectionLog[] | null>(null);
  const [total, setTotal] = useState(0);
  const [workspaces, setWorkspaces] = useState<WhatsAppLogOption[]>([]);
  const [admins, setAdmins] = useState<WhatsAppLogOption[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!admin) router.replace('/settings');
  }, [admin, router]);
  useEffect(() => {
    if (!admin) return;
    let cancelled = false;
    setRows(null);
    setError('');
    fetchWhatsAppConnectionLogs(filter, PAGE, offset)
      .then((p) => {
        if (cancelled) return;
        setRows(p.nodes);
        setTotal(p.total);
        setWorkspaces(p.workspaces);
        setAdmins(p.admins);
      })
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [admin, filter, offset]);
  if (!admin) return null;

  const set = (key: keyof WhatsAppLogFilter, value: string) => {
    setFilter((f) => ({ ...f, [key]: value }));
    setOffset(0);
  };
  const filtered = Object.values(filter).some(Boolean);

  return (
    <div className="max-w-6xl">
      <p className="text-[13px] text-body-soft">
        Every attempt to connect, update or replace the WhatsApp number, and every restore of a backup. Times are Dubai time. Access tokens and secrets are never recorded.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3" role="search" aria-label="Filter activity">
        <label className="text-[12px] font-semibold text-body">
          <span className="mb-1 block">Workspace</span>
          <select className={select} value={filter.workspaceId ?? ''} onChange={(e) => set('workspaceId', e.target.value)}>
            <option value="">All my workspaces</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[12px] font-semibold text-body">
          <span className="mb-1 block">Admin</span>
          <select className={select} value={filter.actorId ?? ''} onChange={(e) => set('actorId', e.target.value)}>
            <option value="">Anyone</option>
            {admins.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[12px] font-semibold text-body">
          <span className="mb-1 block">From</span>
          <input type="date" className={select} value={filter.from ?? ''} max={filter.to || undefined} onChange={(e) => set('from', e.target.value)} />
        </label>
        <label className="text-[12px] font-semibold text-body">
          <span className="mb-1 block">To</span>
          <input type="date" className={select} value={filter.to ?? ''} min={filter.from || undefined} onChange={(e) => set('to', e.target.value)} />
        </label>
        <label className="text-[12px] font-semibold text-body">
          <span className="mb-1 block">Status</span>
          <select className={select} value={filter.status ?? ''} onChange={(e) => set('status', e.target.value)}>
            <option value="">Any</option>
            <option value="success">Success</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        {filtered && (
          <button
            type="button"
            onClick={() => {
              setFilter({});
              setOffset(0);
            }}
            className="rounded-lg px-3 py-2 text-[13px] font-semibold text-primary hover:bg-surface-muted"
          >
            Clear filters
          </button>
        )}
      </div>

      {error && <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
      {!rows && !error && <TableSkeleton />}
      {rows && (
        <div className="mt-4 overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-left text-[13px]" aria-label="WhatsApp connection activity">
            <thead>
              <tr className="border-b border-line bg-surface-muted text-[12px] text-ink">
                <th className="px-4 py-3 font-semibold">Date and time (Dubai)</th>
                <th className="px-2 py-3 font-semibold">Workspace</th>
                <th className="px-2 py-3 font-semibold">Admin</th>
                <th className="px-2 py-3 font-semibold">Action</th>
                <th className="px-2 py-3 font-semibold">Number</th>
                <th className="px-2 py-3 font-semibold">Checks</th>
                <th className="px-2 py-3 font-semibold">Backup</th>
                <th className="px-4 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-body-soft">
                    {filtered ? 'No activity matches these filters.' : 'No WhatsApp connection activity yet.'}
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <tr className="cursor-pointer align-top hover:bg-surface-muted/60" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                    <td className="whitespace-nowrap px-4 py-3 text-ink">{dubai.format(new Date(r.createdAt))}</td>
                    <td className="px-2 py-3 text-body">{r.workspaceName ?? r.workspaceId}</td>
                    <td className="px-2 py-3">
                      <span className="block text-ink">{r.actorName ?? '–'}</span>
                      {r.actorEmail && <span className="block text-[11px] text-faint">{r.actorEmail}</span>}
                    </td>
                    <td className="px-2 py-3 text-body">
                      {ACTIONS[r.action] ?? r.action}
                      <span className="block text-[11px] text-faint">{SOURCES[r.source] ?? r.source}</span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-3 text-body">
                      {r.previousDisplayPhone && r.previousPhoneNumberId !== r.phoneNumberId ? (
                        <>
                          <span className="text-body-soft">{r.previousDisplayPhone}</span> → {r.newDisplayPhone ?? r.phoneNumberId ?? '–'}
                        </>
                      ) : (
                        (r.newDisplayPhone ?? r.previousDisplayPhone ?? r.phoneNumberId ?? '–')
                      )}
                    </td>
                    <td className="px-2 py-3">
                      {r.checks ? (
                        <span className={r.checksPassed === 7 ? 'font-semibold text-primary' : 'font-semibold text-danger'}>{r.checksPassed}/7 passed</span>
                      ) : (
                        <span className="text-faint">{r.action === 'restore' ? 'Not checked' : 'Not run'}</span>
                      )}
                    </td>
                    <td className="px-2 py-3 text-body">{r.backupCreated ? 'Created' : '–'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${r.status === 'success' ? 'bg-primary/10 text-primary' : 'bg-danger-soft text-danger'}`}>
                        {r.status === 'success' ? 'Success' : 'Failed'}
                      </span>
                    </td>
                  </tr>
                  {open === r.id && (
                    <tr className="bg-surface-muted/40">
                      <td colSpan={8} className="px-4 py-4">
                        <Details r={r} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows && total > PAGE && (
        <div className="mt-3 flex items-center justify-end gap-3 text-[12px] text-body-soft">
          <span>
            {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
          </span>
          <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} className="rounded-lg border border-line px-3 py-1.5 font-semibold disabled:opacity-40">
            Previous
          </button>
          <button type="button" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)} className="rounded-lg border border-line px-3 py-1.5 font-semibold disabled:opacity-40">
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function Details({ r }: { r: WhatsAppConnectionLog }) {
  const ran = r.checks ?? [];
  const item = (label: string, value: React.ReactNode) => (
    <div>
      <dt className="text-[11px] font-semibold text-muted">{label}</dt>
      <dd className="break-all font-mono text-[12px] text-ink">{value || '–'}</dd>
    </div>
  );
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <dl className="grid grid-cols-2 gap-3">
        {item('Workspace ID', r.workspaceId)}
        {item('Admin ID', r.actorId)}
        {item('Previous number', r.previousDisplayPhone)}
        {item('New number', r.newDisplayPhone)}
        {item('Previous WABA ID', r.previousWabaId)}
        {item('WABA ID', r.wabaId)}
        {item('Previous phone number ID', r.previousPhoneNumberId)}
        {item('Phone number ID', r.phoneNumberId)}
        {item('Backup', r.backupCreated ? `Created (${r.backupId})` : 'None')}
        {item('Error code', r.errorCode)}
      </dl>
      <div>
        {r.errorReason && <p className="mb-3 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{r.errorReason}</p>}
        <p className="text-[11px] font-semibold text-muted">Checks with Meta</p>
        {r.action === 'restore' ? (
          <p className="mt-1 text-[12px] text-body-soft">A restore puts back credentials that worked before; it isn't checked with Meta.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {CHECK_NAMES.map((name, i) => {
              const c = ran[i];
              return (
                <li key={name} className="flex gap-2 text-[12px]">
                  <span className={!c ? 'text-faint' : c.ok ? 'text-primary' : 'text-danger'}>{!c ? '·' : c.ok ? '✓' : '✗'}</span>
                  <span className="font-semibold text-ink">
                    {i + 1}. {c?.name ?? name}
                  </span>
                  <span className="text-body-soft">{c ? c.detail : 'Not run'}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
