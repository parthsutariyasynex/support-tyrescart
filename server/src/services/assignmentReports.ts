import type { Prisma } from '@prisma/client';
import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { dubaiIso } from '../time.js';
import { AppError } from './errors.js';
import { requireAdmin } from './permissions.js';

// Assignment report: one AssignmentRecord row per assignment, reassignment or unassignment of a chat, with the
// optional reason the person typed in the Assign box.
//
// The reason is report-only. It is never part of a conversation, message, activity/timeline or socket payload:
// the only readers of this table are listAssignmentReport (GraphQL `assignmentReport`) and the CSV export
// (GET /reports/assignments.csv), both of which require an owner or admin of the workspace on the server.

export const REASON_MAX_LENGTH = 500;

// Trims the typed reason; empty means none. Too long or not text is refused.
export function normalizeReason(reason: unknown): string | null {
  if (reason === undefined || reason === null) return null;
  if (typeof reason !== 'string') throw new AppError('Assignment reason must be text', 400, 'BAD_USER_INPUT');
  const trimmed = reason.trim();
  if (!trimmed) return null;
  if (trimmed.length > REASON_MAX_LENGTH)
    throw new AppError(`Assignment reason is too long (max ${REASON_MAX_LENGTH} characters)`, 400, 'BAD_USER_INPUT');
  return trimmed;
}

// A member holding a chat (member id, user id, name at the time); null = unassigned
export type AssignmentParty = { id: string; user: { id: string; name: string } } | null;

// Adds one row. Called inside the same transaction as the chat's assignedToId change, so the record exists
// exactly when the assignment does. Rows are never updated or deleted by the app.
// tx: the transaction (any client that can create an assignment record)
export function recordAssignment(
  tx: { assignmentRecord: { create(args: { data: Prisma.AssignmentRecordUncheckedCreateInput }): Promise<unknown> } },
  data: {
    workspaceId: string;
    conversationId: string;
    previous: AssignmentParty;
    next: AssignmentParty;
    actor: { id: string; name: string } | null;
    reason: string | null;
  },
) {
  return tx.assignmentRecord.create({
    data: {
      workspaceId: data.workspaceId,
      conversationId: data.conversationId,
      previousMemberId: data.previous?.id ?? null,
      previousUserId: data.previous?.user.id ?? null,
      previousName: data.previous?.user.name ?? null,
      newMemberId: data.next?.id ?? null,
      newUserId: data.next?.user.id ?? null,
      newName: data.next?.user.name ?? null,
      assignedById: data.actor?.id ?? null,
      assignedByName: data.actor?.name ?? null,
      reason: data.reason,
    },
  });
}

export type AssignmentReportFilter = { from?: Date | null; to?: Date | null; conversationId?: string | null; first?: number | null };

export const REPORT_MAX_ROWS = 10000;

type Row = Prisma.AssignmentRecordGetPayload<{ include: { conversation: { select: { contact: { select: { name: true; waId: true } } } } } }>;

function toReportRow(r: Row) {
  const party = (memberId: string | null, userId: string | null, name: string | null) =>
    memberId || userId || name ? { memberId, userId, name: name ?? '' } : null;
  return {
    id: r.id,
    conversationId: r.conversationId,
    contactName: r.conversation.contact.name || null,
    contactWaId: r.conversation.contact.waId,
    previousAssignee: party(r.previousMemberId, r.previousUserId, r.previousName),
    newAssignee: party(r.newMemberId, r.newUserId, r.newName),
    assignedBy: r.assignedById || r.assignedByName ? { userId: r.assignedById, name: r.assignedByName ?? '' } : null,
    reason: r.reason,
    createdAt: r.createdAt,
  };
}
export type AssignmentReportRow = ReturnType<typeof toReportRow>;

function validDate(d: Date | null | undefined, name: string) {
  if (d == null) return undefined;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new AppError(`Invalid ${name} date`, 400, 'BAD_USER_INPUT');
  return d;
}

// Owners and admins only; the report never crosses workspaces. Newest first.
export async function listAssignmentReport(auth: AuthPayload, filter: AssignmentReportFilter = {}): Promise<AssignmentReportRow[]> {
  await requireAdmin(auth);
  const from = validDate(filter.from, 'from');
  const to = validDate(filter.to, 'to');
  if (from && to && from > to) throw new AppError('"from" must be before "to"', 400, 'BAD_USER_INPUT');
  const take = Math.min(Math.max(filter.first ?? REPORT_MAX_ROWS, 1), REPORT_MAX_ROWS);
  const rows = await prisma.assignmentRecord.findMany({
    where: {
      workspaceId: auth.workspaceId,
      ...(filter.conversationId ? { conversationId: filter.conversationId } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
    include: { conversation: { select: { contact: { select: { name: true, waId: true } } } } },
  });
  return rows.map(toReportRow);
}

// CSV cell: quoted when needed; a leading =, +, -, @ or tab is prefixed with ' so spreadsheets don't run it as a formula
export function csvCell(value: string | null | undefined) {
  let s = value ?? '';
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_COLUMNS = ['Assigned at (Dubai time)', 'Chat ID', 'Customer', 'Customer number', 'Previous assignee', 'New assignee', 'Assigned by', 'Reason'];

export function assignmentReportCsv(rows: AssignmentReportRow[]) {
  const lines = [CSV_COLUMNS.map(csvCell).join(',')];
  for (const r of rows)
    lines.push(
      [
        dubaiIso(r.createdAt),
        r.conversationId,
        r.contactName,
        r.contactWaId, // digits only (international format without +), as stored
        r.previousAssignee?.name ?? 'Unassigned',
        r.newAssignee?.name ?? 'Unassigned',
        r.assignedBy?.name ?? 'System',
        r.reason,
      ]
        .map(csvCell)
        .join(','),
    );
  return `﻿${lines.join('\r\n')}\r\n`; // BOM so Excel opens UTF-8 names correctly
}
