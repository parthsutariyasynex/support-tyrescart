'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { type AssignmentRecord, dayEndIso, dayStartIso, downloadAssignmentReportCsv, fetchAssignmentReport } from '@/lib/reports';
import { revalidateOnReturn } from '@/lib/revalidate';
import { isAdminRole } from '@/lib/roles';
import { formatDateTime } from '@/lib/time';
import { AppShell, type Me } from '../AppShell';
import { inputClass } from '../AuthShell';

// Reports: owners and admins only (the server refuses the report to everyone else). Supervisors and agents are
// sent back to the Inbox.
export default function ReportsPage() {
  return <AppShell>{(me) => <Reports me={me} />}</AppShell>;
}

function Reports({ me }: { me: Me }) {
  const router = useRouter();
  const admin = isAdminRole(me.role);
  useEffect(() => {
    if (!admin) router.replace('/inbox');
  }, [admin, router]);
  if (!admin) return null;
  return (
    <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
      <AssignmentReport />
    </div>
  );
}

const localDay = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// Assignment report: every assignment, reassignment and unassignment with who did it and the reason given.
// This is the only screen that shows the Assignment Reason.
function AssignmentReport() {
  const today = new Date();
  const monthAgo = new Date(today);
  monthAgo.setDate(today.getDate() - 30);
  const [from, setFrom] = useState(localDay(monthAgo));
  const [to, setTo] = useState(localDay(today));
  const [rows, setRows] = useState<AssignmentRecord[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'load' | 'export' | null>(null);

  const load = useCallback(async () => {
    setBusy('load');
    setError('');
    try {
      setRows(await fetchAssignmentReport({ from: dayStartIso(from), to: dayEndIso(to) }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [from, to]);

  useEffect(() => {
    load();
    return revalidateOnReturn(load); // back to this tab: fresh rows
  }, [load]);

  async function exportCsv() {
    setBusy('export');
    setError('');
    try {
      await downloadAssignmentReportCsv({ from: dayStartIso(from), to: dayEndIso(to) });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const name = (p: { name: string } | null) => p?.name ?? 'Unassigned';

  return (
    <section className="rounded-2xl border border-line bg-surface p-5 text-ink-soft shadow-xs">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-ink">Assignment report</h2>
          <p className="mt-0.5 text-xs text-muted">Every assignment, reassignment and unassignment, with who did it and the reason given.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-[11px] font-medium text-muted">
            From
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={`${inputClass} mt-1 w-40`} />
          </label>
          <label className="text-[11px] font-medium text-muted">
            To
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={`${inputClass} mt-1 w-40`} />
          </label>
          <button
            type="button"
            disabled={busy !== null || !rows?.length}
            onClick={exportCsv}
            className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
          >
            {busy === 'export' ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      </div>

      {error && <div className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wide text-faint">
              <th className="py-2 pr-3 font-semibold">Assigned at</th>
              <th className="py-2 pr-3 font-semibold">Chat</th>
              <th className="py-2 pr-3 font-semibold">Previous assignee</th>
              <th className="py-2 pr-3 font-semibold">New assignee</th>
              <th className="py-2 pr-3 font-semibold">Assigned by</th>
              <th className="py-2 font-semibold">Reason</th>
            </tr>
          </thead>
          <tbody>
            {rows === null && !error && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-muted">
                  Loading…
                </td>
              </tr>
            )}
            {rows?.length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-muted">
                  No assignments in this period.
                </td>
              </tr>
            )}
            {rows?.map((r) => (
              <tr key={r.id} className="border-b border-line-soft align-top">
                <td className="whitespace-nowrap py-2 pr-3 text-body">{formatDateTime(r.createdAt)}</td>
                <td className="py-2 pr-3">
                  <div className="text-body">{r.contactName || `+${r.contactWaId}`}</div>
                  <div className="font-mono text-[10px] text-faint">{r.conversationId}</div>
                </td>
                <td className="py-2 pr-3 text-body">{name(r.previousAssignee)}</td>
                <td className="py-2 pr-3 text-body">{name(r.newAssignee)}</td>
                <td className="py-2 pr-3 text-body">{r.assignedBy?.name ?? 'System'}</td>
                <td className="py-2 text-body whitespace-pre-wrap break-words">{r.reason ?? <span className="text-faint">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows && rows.length > 0 && <p className="mt-3 text-[11px] text-faint">{rows.length} record{rows.length === 1 ? '' : 's'}</p>}
    </section>
  );
}
