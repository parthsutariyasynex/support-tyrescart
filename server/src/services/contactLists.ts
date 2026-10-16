import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { recordActivity } from './activity.js';
import { AppError, notFound } from './errors.js';
import { getPermissions } from './permissions.js';
import { parse } from './validate.js';

// Contact lists (profile panel "Lists"): named groups of customers, e.g. VIP or Leads.
// Every member of the workspace can create lists and add or remove customers; only owners/admins delete a list.
// Names are unique per workspace (case-insensitive, MySQL's default collation). Live updates: contactList:saved,
// contactList:deleted, and contact:lists (a customer's lists changed).

const nameSchema = z.string({ message: 'List name must be text' }).trim().min(1, 'List name is required').max(100, 'List name is too long (max 100 characters)');

const withCount = { _count: { select: { members: true } } } as const;
type Row = Prisma.ContactListGetPayload<{ include: typeof withCount }>;
const toList = (l: Row) => ({ id: l.id, name: l.name, contactCount: l._count.members, createdAt: l.createdAt });

// All the workspace's lists, A to Z, with how many customers each has
export async function listContactLists(auth: AuthPayload) {
  await getPermissions(auth);
  const rows = await prisma.contactList.findMany({ where: { workspaceId: auth.workspaceId }, include: withCount, orderBy: { name: 'asc' } });
  return rows.map(toList);
}

export async function createContactList(auth: AuthPayload, name: string) {
  await getPermissions(auth);
  const clean = parse(nameSchema, name);
  try {
    const row = await prisma.contactList.create({ data: { workspaceId: auth.workspaceId, name: clean, createdById: auth.userId }, include: withCount });
    const list = toList(row);
    emitToWorkspace(auth.workspaceId, 'contactList:saved', list);
    return list;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new AppError(`A list named "${clean}" already exists`, 409, 'DUPLICATE');
    throw err;
  }
}

export async function deleteContactList(auth: AuthPayload, id: string) {
  const { isAdmin } = await getPermissions(auth);
  if (!isAdmin) throw new AppError('Only owners and admins can delete a list', 403, 'FORBIDDEN');
  const row = await prisma.contactList.findFirst({ where: { id, workspaceId: auth.workspaceId } });
  if (!row) throw notFound('List');
  // Each customer in it gets "Removed from list" (list deleted) in their activity log
  const members = await prisma.contactListMember.findMany({ where: { listId: id }, select: { contactId: true } });
  await prisma.contactList.delete({ where: { id } }); // its memberships go with it
  emitToWorkspace(auth.workspaceId, 'contactList:deleted', { id });
  for (const m of members) await logList(auth, m.contactId, 'list_removed', row.name, true);
  return true;
}

// The lists one customer is in, A to Z
export async function listsOfContact(workspaceId: string, contactId: string) {
  const rows = await prisma.contactListMember.findMany({ where: { contactId, list: { workspaceId } }, include: { list: true } });
  return rows.map((r) => ({ id: r.list.id, name: r.list.name })).sort((a, b) => a.name.localeCompare(b.name));
}

const listName = async (id: string) => (await prisma.contactList.findUnique({ where: { id }, select: { name: true } }))?.name ?? 'a list';

async function requireBoth(workspaceId: string, contactId: string, listId: string) {
  const [contact, list] = await Promise.all([
    prisma.contact.findFirst({ where: { id: contactId, workspaceId }, select: { id: true } }),
    prisma.contactList.findFirst({ where: { id: listId, workspaceId }, select: { id: true } }),
  ]);
  if (!contact) throw notFound('Contact');
  if (!list) throw notFound('List');
}

// Contact details page activity log: "Added to list by …" / "Removed from list by …"
async function logList(auth: AuthPayload, contactId: string, type: 'list_added' | 'list_removed', list: string, listDeleted = false) {
  const conversation = await prisma.conversation.findFirst({ where: { workspaceId: auth.workspaceId, contactId }, select: { id: true } });
  if (!conversation) return;
  await recordActivity({ workspaceId: auth.workspaceId, conversationId: conversation.id, actorId: auth.userId, type, data: { list, ...(listDeleted ? { reason: 'list_deleted' } : {}) } });
}

async function announce(workspaceId: string, contactId: string, listId: string) {
  const lists = await listsOfContact(workspaceId, contactId);
  emitToWorkspace(workspaceId, 'contact:lists', { contactId, lists });
  const row = await prisma.contactList.findUnique({ where: { id: listId }, include: withCount });
  if (row) emitToWorkspace(workspaceId, 'contactList:saved', toList(row)); // its count changed
  return lists;
}

// Both return the customer's lists afterwards. Adding twice or removing a non-member changes nothing.
export async function addContactToList(auth: AuthPayload, contactId: string, listId: string) {
  await getPermissions(auth);
  await requireBoth(auth.workspaceId, contactId, listId);
  const { count } = await prisma.contactListMember.createMany({ data: [{ listId, contactId, addedById: auth.userId }], skipDuplicates: true });
  if (count) await logList(auth, contactId, 'list_added', await listName(listId));
  return announce(auth.workspaceId, contactId, listId);
}

export async function removeContactFromList(auth: AuthPayload, contactId: string, listId: string) {
  await getPermissions(auth);
  await requireBoth(auth.workspaceId, contactId, listId);
  const { count } = await prisma.contactListMember.deleteMany({ where: { listId, contactId } });
  if (count) await logList(auth, contactId, 'list_removed', await listName(listId));
  return announce(auth.workspaceId, contactId, listId);
}
