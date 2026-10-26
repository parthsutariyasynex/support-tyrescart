import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { AuthPayload } from '../auth.js';
import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { AppError, notFound } from './errors.js';
import { requireAdmin } from './permissions.js';
import { DEFAULTS, settingsOf } from './workspaceSettings.js';
import { logFailure } from './logging.js';

// Deleting a contact (admins): it and its chat leave the app at once but are kept for RETENTION_DAYS in Settings →
// Recently deleted contacts, where an admin can restore them. After that they are removed for good, with the chat,
// its messages and stored files. A deleted contact who messages the business again comes back (see saveIncoming),
// so no customer message is ever lost.
export const RETENTION_DAYS = DEFAULTS.deletedContactRetentionDays; // default; each workspace can change it
const DAY_MS = 86_400_000;

async function conversationOf(workspaceId: string, contactId: string) {
  return (await prisma.conversation.findFirst({ where: { workspaceId, contactId }, select: { id: true } }))?.id ?? null;
}

export async function deleteContact(auth: AuthPayload, id: string) {
  await requireAdmin(auth);
  const contact = await prisma.contact.findFirst({ where: { id, workspaceId: auth.workspaceId, deletedAt: null } });
  if (!contact) throw notFound('Contact');
  const deletedAt = new Date();
  await prisma.contact.update({ where: { id }, data: { deletedAt, deletedBy: auth.userId, updatedBy: auth.userId } });
  emitToWorkspace(auth.workspaceId, 'contact:deleted', { contactId: id, conversationId: await conversationOf(auth.workspaceId, id) });
  const days = (await settingsOf(auth.workspaceId)).deletedContactRetentionDays;
  return { id, deletedAt, purgeAt: new Date(deletedAt.getTime() + days * DAY_MS) };
}

export async function restoreContact(auth: AuthPayload, id: string) {
  await requireAdmin(auth);
  const contact = await prisma.contact.findFirst({ where: { id, workspaceId: auth.workspaceId } });
  if (!contact) throw notFound('Contact');
  if (!contact.deletedAt) throw new AppError('This contact is not deleted', 400, 'BAD_USER_INPUT');
  await prisma.contact.update({ where: { id }, data: { deletedAt: null, deletedBy: null, updatedBy: auth.userId } });
  emitToWorkspace(auth.workspaceId, 'contact:restored', { contactId: id, conversationId: await conversationOf(auth.workspaceId, id) });
  return true;
}

// Newest deletion first, with who deleted it and when it goes for good
export async function listDeletedContacts(auth: AuthPayload) {
  await requireAdmin(auth);
  const rows = await prisma.contact.findMany({
    where: { workspaceId: auth.workspaceId, deletedAt: { not: null } },
    orderBy: [{ deletedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, waId: true, name: true, firstName: true, lastName: true, email: true, deletedAt: true, deletedBy: true },
  });
  const ids = [...new Set(rows.map((r) => r.deletedBy).filter((x): x is string => !!x))];
  const days = (await settingsOf(auth.workspaceId)).deletedContactRetentionDays;
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  return rows.map((r) => ({
    ...r,
    deletedByName: users.find((u) => u.id === r.deletedBy)?.name ?? null,
    purgeAt: new Date(r.deletedAt!.getTime() + days * DAY_MS),
  }));
}

// Removes contacts deleted longer ago than their workspace keeps them, with their stored chat files
export async function purgeDeletedContacts(now = new Date()) {
  const deleted = await prisma.contact.findMany({ where: { deletedAt: { not: null } }, select: { id: true, workspaceId: true, deletedAt: true } });
  const due: { id: string }[] = [];
  for (const c of deleted) {
    const days = (await settingsOf(c.workspaceId)).deletedContactRetentionDays;
    if (c.deletedAt!.getTime() < now.getTime() - days * DAY_MS) due.push(c);
  }
  if (!due.length) return 0;
  const ids = due.map((c) => c.id);
  const files = await prisma.message.findMany({ where: { conversation: { contactId: { in: ids } }, mediaPath: { not: null } }, select: { mediaPath: true } });
  const { count } = await prisma.contact.deleteMany({ where: { id: { in: ids } } }); // chat, messages, remarks… go with it
  for (const f of files) {
    const full = path.resolve(env.uploadsDir, f.mediaPath!);
    if (full.startsWith(env.uploadsDir + path.sep))
      await rm(full, { force: true }).catch((err) => logFailure('file.remove_failed', "Couldn't remove a purged chat's file", err, { level: 'WARNING', data: { path: f.mediaPath } }));
  }
  return count;
}

export function startDeletedContactsPurge(intervalMs = 60 * 60_000) {
  const run = () =>
    purgeDeletedContacts().catch((err) => {
      console.error('[contacts] purge failed', err);
      void logFailure('job.purge_failed', 'Purging deleted contacts failed', err);
    });
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
