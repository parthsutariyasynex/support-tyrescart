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

const labelInclude = { _count: { select: { conversations: true } } };

// Same shape for the API and Socket.IO payloads
function toLabel({ _count, workspaceId: _, ...label }: Prisma.LabelGetPayload<{ include: typeof labelInclude }>) {
  return { ...label, conversationCount: _count.conversations };
}

const nameSchema = z.string().trim().min(1, 'Label name is required').max(50, 'Label name is too long');
const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a hex value like #25d366')
  .transform((v) => v.toLowerCase());

const createSchema = z.object({ name: nameSchema, color: colorSchema });
const updateSchema = z.object({ name: nameSchema.optional(), color: colorSchema.optional() });

// Names are unique per workspace (case-insensitive with MySQL's default collation)
function duplicateName(err: unknown) {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
    return new AppError('A label with this name already exists', 409, 'LABEL_EXISTS');
  return err;
}

export async function listLabels(workspaceId: string) {
  const labels = await prisma.label.findMany({ where: { workspaceId }, orderBy: { name: 'asc' }, include: labelInclude });
  return labels.map(toLabel);
}

async function requireLabel(workspaceId: string, id: string) {
  const label = await prisma.label.findFirst({ where: { id, workspaceId } });
  if (!label) throw notFound('Label');
  return label;
}

export async function createLabel(auth: AuthPayload, rawInput: unknown) {
  await requireLabelManager(auth);
  const { workspaceId } = auth;
  const data = parse(createSchema, rawInput);
  const label = toLabel(
    await prisma.label.create({ data: { workspaceId, ...data }, include: labelInclude }).catch((err) => {
      throw duplicateName(err);
    }),
  );
  emitToWorkspace(workspaceId, 'label:saved', label);
  return label;
}

export async function updateLabel(auth: AuthPayload, id: string, rawInput: unknown) {
  await requireLabelManager(auth);
  const { workspaceId } = auth;
  const data = parse(updateSchema, rawInput);
  await requireLabel(workspaceId, id);
  const label = toLabel(
    await prisma.label.update({ where: { id }, data, include: labelInclude }).catch((err) => {
      throw duplicateName(err);
    }),
  );
  emitToWorkspace(workspaceId, 'label:saved', label);
  return label;
}

// Also removes the label from every conversation (cascade)
export async function deleteLabel(auth: AuthPayload, id: string) {
  await requireLabelManager(auth);
  const { workspaceId } = auth;
  await requireLabel(workspaceId, id);
  await prisma.label.delete({ where: { id } });
  emitToWorkspace(workspaceId, 'label:deleted', { id });
  return id;
}

export function conversationLabels(conversationId: string) {
  return prisma.label.findMany({
    where: { conversations: { some: { conversationId } } },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, color: true, createdAt: true },
  });
}

async function labelsChanged(workspaceId: string, conversationId: string) {
  const labels = await conversationLabels(conversationId);
  emitToWorkspace(workspaceId, 'conversation:labels', { conversationId, labels });
  return requireConversation(workspaceId, conversationId);
}

// Assigning twice is a no-op. `actorId` (the agent doing it) is only used for the activity history.
export async function addConversationLabel(
  workspaceId: string,
  conversationId: string,
  labelId: string,
  actorId: string | null = null,
) {
  const [, label] = await Promise.all([requireConversation(workspaceId, conversationId), requireLabel(workspaceId, labelId)]);
  const where = { conversationId_labelId: { conversationId, labelId } };
  const existed = await prisma.conversationLabel.findUnique({ where });
  await prisma.conversationLabel.upsert({ where, update: {}, create: { conversationId, labelId } });
  const result = await labelsChanged(workspaceId, conversationId);
  if (!existed)
    await recordActivity({
      workspaceId,
      conversationId,
      actorId,
      type: 'label_added',
      data: { label: label.name, color: label.color },
    });
  return result;
}

export async function removeConversationLabel(
  workspaceId: string,
  conversationId: string,
  labelId: string,
  actorId: string | null = null,
) {
  const [, label] = await Promise.all([requireConversation(workspaceId, conversationId), requireLabel(workspaceId, labelId)]);
  const { count } = await prisma.conversationLabel.deleteMany({ where: { conversationId, labelId } });
  const result = await labelsChanged(workspaceId, conversationId);
  if (count > 0)
    await recordActivity({
      workspaceId,
      conversationId,
      actorId,
      type: 'label_removed',
      data: { label: label.name, color: label.color },
    });
  return result;
}
