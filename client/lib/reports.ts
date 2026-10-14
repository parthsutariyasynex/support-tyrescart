import { API_URL, getToken, gql } from './api';

// Reports section (owners and admins only on the server). The assignment report is the only place the
// Assignment Reason is ever shown: it is not part of chats, history or the activity timeline.
export type AssignmentParty = { memberId: string | null; userId: string | null; name: string };
export type AssignmentRecord = {
  id: string;
  conversationId: string;
  contactName: string | null;
  contactWaId: string;
  previousAssignee: AssignmentParty | null;
  newAssignee: AssignmentParty | null;
  assignedBy: { userId: string | null; name: string } | null;
  reason: string | null;
  createdAt: string;
};

export type ReportRange = { from?: string | null; to?: string | null };

export async function fetchAssignmentReport(range: ReportRange = {}, first = 1000) {
  const query = `query AssignmentReport($from: DateTime, $to: DateTime, $first: Int) {
    assignmentReport(from: $from, to: $to, first: $first) {
      id conversationId contactName contactWaId
      previousAssignee { memberId userId name }
      newAssignee { memberId userId name }
      assignedBy { userId name }
      reason createdAt
    }
  }`;
  return (await gql<{ assignmentReport: AssignmentRecord[] }>(query, { from: range.from ?? null, to: range.to ?? null, first })).assignmentReport;
}

// Downloads the CSV export (GET /reports/assignments.csv) with the signed-in user's token
export async function downloadAssignmentReportCsv(range: ReportRange = {}) {
  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  const token = getToken();
  const res = await fetch(`${API_URL}/reports/assignments.csv${params.size ? `?${params}` : ''}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Export failed (${res.status})`);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'assignment-report.csv';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return name;
}

// Local calendar day (yyyy-mm-dd) -> ISO bounds for the server (start of day / end of day, in the browser's zone)
export function dayStartIso(day: string) {
  return day ? new Date(`${day}T00:00:00`).toISOString() : null;
}
export function dayEndIso(day: string) {
  return day ? new Date(`${day}T23:59:59.999`).toISOString() : null;
}
