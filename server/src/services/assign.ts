import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToUser, emitToWorkspace } from '../realtime.js';
import { AppError, notFound } from './errors.js';
import { recordActivity } from './activity.js';
import { requireConversation } from './inbox.js';
import { getPermissions, requireAssignmentManager, requireLabelManager } from './permissions.js';
import { ASSIGNABLE_TO_ROLES, ROLE_COLORS } from './roles.js';
import { parse } from './validate.js';

// Assignees work like labels (name + colour, managed per workspace), but a conversation has at most one
const assigneeInclude = { _count: { select: { conversations: true } } };

// Same shape for the API and Socket.IO payloads
function toAssignee({ _count, workspaceId: _, ...a }: Prisma.AssigneeGetPayload<{ include: typeof assigneeInclude }>) {
  return { ...a, conversationCount: _count.conversations };
}

const nameSchema = z.string().trim().min(1, 'Name is required').max(50, 'Name is too long');
const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a hex value like #25d366')
  .transform((v) => v.toLowerCase());

// userId: the workspace member this assignee is (null = not linked to anyone)
const userIdSchema = z.string().min(1).nullable();
const createSchema = z.object({ name: nameSchema, color: colorSchema, userId: userIdSchema.optional() });
const updateSchema = z.object({ name: nameSchema.optional(), color: colorSchema.optional(), userId: userIdSchema.optional() });

const userTaken = () => new AppError('This user is already linked to another assignee', 409, 'ASSIGNEE_USER_TAKEN');

// Names are unique per workspace (case-insensitive with MySQL's default collation), and so are linked users
function duplicateName(err: unknown) {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
    return String(err.meta?.target ?? '').includes('userId')
      ? userTaken()
      : new AppError('An assignee with this name already exists', 409, 'ASSIGNEE_EXISTS');
  return err;
}

// A linked user must be a member of this workspace and not already linked to another assignee
async function requireLinkableUser(workspaceId: string, userId: string, exceptAssigneeId?: string) {
  const member = await prisma.member.findUnique({ where: { userId_workspaceId: { userId, workspaceId } } });
  if (!member) throw notFound('Member');
  const taken = await prisma.assignee.findFirst({
    where: { workspaceId, userId, ...(exceptAssigneeId ? { id: { not: exceptAssigneeId } } : {}) },
  });
  if (taken) throw userTaken();
}

// Everyone in the current workspace (the Assign menu and linking an assignee to a person): name, email and role
export async function listWorkspaceMembers(workspaceId: string) {
  const members = await prisma.member.findMany({ where: { workspaceId }, include: { user: { select: { id: true, name: true, email: true } } } });
  return members
    .map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email, role: m.role }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listAssignees(workspaceId: string) {
  const rows = await prisma.assignee.findMany({ where: { workspaceId }, orderBy: { name: 'asc' }, include: assigneeInclude });
  return rows.map(toAssignee);
}

async function requireAssignee(workspaceId: string, id: string) {
  const assignee = await prisma.assignee.findFirst({ where: { id, workspaceId } });
  if (!assignee) throw notFound('Assignee');
  return assignee;
}

export async function createAssignee(auth: AuthPayload, rawInput: unknown) {
  await requireLabelManager(auth);
  const { workspaceId } = auth;
  const data = parse(createSchema, rawInput);
  if (data.userId) {
    await requireAssignmentManager(auth); // linking to a person
    await requireLinkableUser(workspaceId, data.userId);
  }
  const assignee = toAssignee(
    await prisma.assignee.create({ data: { workspaceId, ...data }, include: assigneeInclude }).catch((err) => {
      throw duplicateName(err);
    }),
  );
  emitToWorkspace(workspaceId, 'assignee:saved', assignee);
  return assignee;
}

export async function updateAssignee(auth: AuthPayload, id: string, rawInput: unknown) {
  await requireLabelManager(auth);
  const { workspaceId } = auth;
  const data = parse(updateSchema, rawInput);
  const current = await requireAssignee(workspaceId, id);
  // Changing who it's linked to (link, unlink or relink) moves that person's chats
  if (data.userId !== undefined && data.userId !== current.userId) await requireAssignmentManager(auth);
  if (data.userId) await requireLinkableUser(workspaceId, data.userId, id);
  const assignee = toAssignee(
    await prisma.assignee.update({ where: { id }, data, include: assigneeInclude }).catch((err) => {
      throw duplicateName(err);
    }),
  );
  emitToWorkspace(workspaceId, 'assignee:saved', assignee);
  return assignee;
}

// The assignee was deleted between our check and the write (foreign key / missing row)
function missingAssignee(err: unknown) {
  if (err instanceof Prisma.PrismaClientKnownRequestError && ['P2003', 'P2025'].includes(err.code)) return notFound('Assignee');
  return err;
}

// Their conversations become unassigned (onDelete: SetNull), and each gets an "unassigned" entry in its history.
// The assignee row is locked first, so an assign to it running at the same time waits and then fails as
// "not found" instead of losing its assignee without a history entry.
export async function deleteAssignee(auth: AuthPayload, id: string) {
  await requireLabelManager(auth);
  await requireAssignmentManager(auth); // unassigns all its chats
  const { workspaceId } = auth;
  const assignee = await requireAssignee(workspaceId, id);
  const conversationIds = await prisma
    .$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM Assignee WHERE id = ${id} FOR UPDATE`;
      const rows = await tx.conversation.findMany({ where: { workspaceId, assignedToId: id }, select: { id: true } });
      await tx.assignee.delete({ where: { id } });
      return rows.map((r) => r.id);
    })
    .catch((err) => {
      throw missingAssignee(err);
    });
  emitToWorkspace(workspaceId, 'assignee:deleted', { id });
  for (const conversationId of conversationIds)
    await recordActivity({
      workspaceId,
      conversationId,
      actorId: auth.userId,
      type: 'unassigned',
      data: { assignee: assignee.name, reason: 'assignee_deleted' },
    });
  return id;
}

// Orphaned assignees: names with no member behind them (removed before removal cleaned up, or never linked).
// Deletes only the ones holding no chats; the rest are reported and kept, since deleting them would unassign
// chats. Nothing else is touched. Returns what was deleted and what was kept, for the cleanup script's report.
export async function removeOrphanAssignees(workspaceId: string) {
  const orphans = await prisma.assignee.findMany({
    where: { workspaceId, userId: null },
    include: { _count: { select: { conversations: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const summary = (a: (typeof orphans)[number]) => ({ id: a.id, name: a.name, chats: a._count.conversations, createdAt: a.createdAt });
  const deleted = [];
  for (const a of orphans.filter((o) => o._count.conversations === 0)) {
    // Re-checked inside the delete so a chat assigned to it meanwhile keeps its assignee
    const { count } = await prisma.assignee.deleteMany({ where: { id: a.id, userId: null, conversations: { none: {} } } });
    if (count === 0) continue;
    deleted.push(summary(a));
    emitToWorkspace(workspaceId, 'assignee:deleted', { id: a.id });
  }
  const deletedIds = new Set(deleted.map((d) => d.id));
  return { deleted, kept: orphans.filter((o) => !deletedIds.has(o.id)).map(summary) };
}

// Assigning a chat to a person (a Supervisor or Agent of this workspace) uses the assignee linked to them,
// created the first time, so filters, counts, "Assigned to me" and notifications work exactly as for any
// assignee. Agents may only do this for themselves (taking an unassigned chat); the rest of the rules are
// in assignConversation.
export async function assignConversationToMember(auth: AuthPayload, conversationId: string, memberId: string) {
  const { workspaceId, userId } = auth;
  await requireConversation(workspaceId, conversationId);
  // Checked before anything is created, so a refused request leaves no new assignee behind
  if (!(await getPermissions(auth)).canManageAssignments) throw new AppError(
      'Only admins can assign or unassign chats. Use Assign to Me on New Leads.',
      403,
      'FORBIDDEN',
    );
  const assignee = await assigneeForMember(workspaceId, memberId);
  return assignConversation(workspaceId, conversationId, assignee.id, userId);
}

async function assigneeForMember(workspaceId: string, userId: string) {
  const member = await prisma.member.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    include: { user: { select: { name: true } } },
  });
  if (!member) throw notFound('Member'); // removed, or never in this workspace
  if (!(ASSIGNABLE_TO_ROLES as readonly string[]).includes(member.role))
    throw new AppError('Chats can be assigned to supervisors and agents', 400, 'NOT_ASSIGNABLE');
  const linked = await prisma.assignee.findFirst({ where: { workspaceId, userId } });
  if (linked) return linked;

  // Assignee names are unique per workspace: if the person's name is taken, number it ("Asha (2)")
  const base = member.user.name.trim().slice(0, 50) || 'Member';
  for (let n = 1; n <= 20; n++) {
    const name = n === 1 ? base : `${base.slice(0, 50 - ` (${n})`.length)} (${n})`;
    try {
      const created = await prisma.assignee.create({
        data: { workspaceId, userId, name, color: ROLE_COLORS[member.role] ?? ROLE_COLORS.agent },
        include: assigneeInclude,
      });
      emitToWorkspace(workspaceId, 'assignee:saved', toAssignee(created));
      return created;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      // Someone created their assignee at the same moment: use that one
      const raced = await prisma.assignee.findFirst({ where: { workspaceId, userId } });
      if (raced) return raced;
    }
  }
  throw new AppError('Could not create an assignee for this person', 409, 'ASSIGNEE_EXISTS');
}

// "Assign to Me" on a New Lead: take an unassigned chat for yourself. The write only applies while the chat is
// still unassigned (compare-and-set), so when two people click at the same moment exactly one gets it and the
// other is told who has it. Nobody's role changes; the chat simply moves to your My Chats.
export async function claimConversation(auth: AuthPayload, conversationId: string) {
  const { workspaceId, userId } = auth;
  await getPermissions(auth); // a current member of this workspace (any role)
  const conversation = await requireConversation(workspaceId, conversationId);
  if (conversation.assignedToId) {
    const own = await prisma.assignee.findFirst({ where: { workspaceId, userId }, select: { id: true } });
    if (conversation.assignedToId === own?.id) return conversation; // already yours
    throw await alreadyAssigned(conversation.assignedToId);
  }
  const assignee = await assigneeForMember(workspaceId, userId);
  return assignConversation(workspaceId, conversationId, assignee.id, userId, { claim: true });
}

async function alreadyAssigned(assigneeId: string) {
  const a = await prisma.assignee.findUnique({ where: { id: assigneeId }, select: { name: true } });
  return new AppError(`This chat was already taken by ${a?.name ?? 'someone else'}.`, 409, 'ALREADY_ASSIGNED');
}

const ASSIGN_ATTEMPTS = 3;

// Pass null to unassign. `actorId` is the agent doing it (history and notifications).
// Compare-and-set: the write only applies if the chat still has the assignee we just read, so when two agents
// reassign at once each history entry names the real previous assignee. Assigning the current one changes
// nothing, so it sends no event and records no history.
export async function assignConversation(
  workspaceId: string,
  conversationId: string,
  assigneeId: string | null,
  actorId: string | null = null,
  // claim: "Assign to Me" on a New Lead (the caller checked it's the actor's own assignee); succeeds only while
  // the chat is still unassigned, for every role
  options: { claim?: boolean } = {},
) {
  const assignee = assigneeId ? await requireAssignee(workspaceId, assigneeId) : null;
  // Owners and admins assign, reassign and unassign. Everyone else (supervisors and agents) can only "Assign to
  // Me" an unassigned chat (claimConversation). getPermissions also refuses non-members.
  if (actorId && !options.claim && !(await getPermissions({ userId: actorId, workspaceId })).canManageAssignments)
    throw new AppError('Only admins can assign or unassign chats. Use Assign to Me on New Leads.', 403, 'FORBIDDEN');
  for (let attempt = 0; attempt < ASSIGN_ATTEMPTS; attempt++) {
    const before = await requireConversation(workspaceId, conversationId);
    if (before.assignedToId === assigneeId) return before;
    if (options.claim && before.assignedToId !== null) throw await alreadyAssigned(before.assignedToId);
    const previous = before.assignedToId
      ? await prisma.assignee.findUnique({ where: { id: before.assignedToId }, select: { name: true, userId: true } })
      : null;
    const { count } = await prisma.conversation
      .updateMany({
        where: { id: conversationId, workspaceId, assignedToId: before.assignedToId },
        data: { assignedToId: assigneeId },
      })
      .catch((err) => {
        throw missingAssignee(err);
      });
    if (count === 0) continue; // changed by someone else in between: read it again

    const payload = assignee && {
      id: assignee.id,
      name: assignee.name,
      color: assignee.color,
      userId: assignee.userId,
      createdAt: assignee.createdAt,
    };
    emitToWorkspace(workspaceId, 'conversation:assigned', { conversationId, assignee: payload });
    await recordActivity({
      workspaceId,
      conversationId,
      actorId,
      type: !assignee ? 'unassigned' : previous ? 'reassigned' : 'assigned',
      data: assignee
        ? {
            assignee: assignee.name,
            color: assignee.color,
            ...(previous ? { previous: previous.name } : {}),
            ...(assignee.userId ? { assigneeUserId: assignee.userId } : {}),
          }
        : { assignee: previous?.name ?? null },
    });
    // Tell the people affected (assignees linked to someone), unless they did it themselves:
    // the new assignee gets assignment:you; whoever it was taken from gets assignment:removed
    const notifyNew = assignee?.userId && assignee.userId !== actorId ? assignee.userId : null;
    const notifyPrevious = previous?.userId && previous.userId !== actorId ? previous.userId : null;
    if (notifyNew || notifyPrevious) {
      const actor = actorId ? await prisma.user.findUnique({ where: { id: actorId }, select: { name: true } }) : null;
      const event = {
        conversationId,
        assignee: payload,
        actorName: actor?.name ?? null,
        contactName: before.contact.name || `+${before.contact.waId}`,
      };
      if (notifyNew) emitToUser(workspaceId, notifyNew, 'assignment:you', event);
      if (notifyPrevious) emitToUser(workspaceId, notifyPrevious, 'assignment:removed', { ...event, previous: previous!.name });
    }
    return requireConversation(workspaceId, conversationId);
  }
  throw new AppError('Someone else changed the assignee at the same time. Try again.', 409, 'ASSIGN_CONFLICT');
}
