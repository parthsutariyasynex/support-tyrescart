import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { AppError, notFound } from './errors.js';
import { recordActivity } from './activity.js';
import { requireConversation } from './inbox.js';
import { requireLabelManager } from './permissions.js';
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

const createSchema = z.object({ name: nameSchema, color: colorSchema });
const updateSchema = z.object({ name: nameSchema.optional(), color: colorSchema.optional() });

// Names are unique per workspace (case-insensitive with MySQL's default collation)
function duplicateName(err: unknown) {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
    return new AppError('An assignee with this name already exists', 409, 'ASSIGNEE_EXISTS');
  return err;
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
  await requireAssignee(workspaceId, id);
  const assignee = toAssignee(
    await prisma.assignee.update({ where: { id }, data, include: assigneeInclude }).catch((err) => {
      throw duplicateName(err);
    }),
  );
  emitToWorkspace(workspaceId, 'assignee:saved', assignee);
  return assignee;
}

// Their conversations become unassigned (onDelete: SetNull)
export async function deleteAssignee(auth: AuthPayload, id: string) {
  await requireLabelManager(auth);
  const { workspaceId } = auth;
  await requireAssignee(workspaceId, id);
  await prisma.assignee.delete({ where: { id } });
  emitToWorkspace(workspaceId, 'assignee:deleted', { id });
  return id;
}

// Pass null to unassign
// `actorId` (the agent doing it) is only used for the activity history
export async function assignConversation(
  workspaceId: string,
  conversationId: string,
  assigneeId: string | null,
  actorId: string | null = null,
) {
  const before = await requireConversation(workspaceId, conversationId);
  const assignee = assigneeId ? await requireAssignee(workspaceId, assigneeId) : null;
  await prisma.conversation.update({ where: { id: conversationId }, data: { assignedToId: assigneeId } });
  const payload = assignee && { id: assignee.id, name: assignee.name, color: assignee.color, createdAt: assignee.createdAt };
  emitToWorkspace(workspaceId, 'conversation:assigned', { conversationId, assignee: payload });
  if (before.assignedToId !== assigneeId) {
    const previous = before.assignedToId
      ? await prisma.assignee.findUnique({ where: { id: before.assignedToId }, select: { name: true } })
      : null;
    await recordActivity({
      workspaceId,
      conversationId,
      actorId,
      type: assignee ? 'assigned' : 'unassigned',
      data: assignee ? { assignee: assignee.name, color: assignee.color } : { assignee: previous?.name ?? null },
    });
  }
  return requireConversation(workspaceId, conversationId);
}
