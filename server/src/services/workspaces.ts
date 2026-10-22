import { z } from 'zod';
import { signToken, type AuthPayload } from '../auth.js';
import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { AppError } from './errors.js';
import { notFound } from './errors.js';
import { requireAdmin } from './permissions.js';
import { parse } from './validate.js';

// A user can belong to several workspaces; their token says which one they're working in.
// Creating or switching hands back a token for that workspace.

const createSchema = z.object({
  name: z.string().trim().min(1, 'Workspace name is required').max(191, 'Workspace name is too long'),
});

export async function listWorkspaces({ userId }: AuthPayload) {
  const members = await prisma.member.findMany({
    where: { userId },
    select: { role: true, workspace: { select: { id: true, name: true, createdAt: true } } },
    orderBy: { workspace: { createdAt: 'asc' } },
  });
  return members.map((m) => ({ ...m.workspace, role: m.role }));
}

// The creator becomes its owner
export async function createWorkspace({ userId }: AuthPayload, rawInput: unknown) {
  if (!env.allowWorkspaceCreation) throw new AppError('Creating workspaces is turned off', 403, 'WORKSPACE_CREATION_CLOSED');
  const { name } = parse(createSchema, rawInput);
  const workspace = await prisma.workspace.create({
    data: { name, createdBy: userId, members: { create: { userId, role: 'owner', createdBy: userId } } },
  });
  return { token: signToken({ userId, workspaceId: workspace.id }), userId };
}

// Settings → Company details (owners and admins): the company name, shown across the app and used as {{company.name}}
export async function renameWorkspace(auth: AuthPayload, rawInput: unknown) {
  await requireAdmin(auth);
  const { name } = parse(createSchema, rawInput);
  const workspace = await prisma.workspace.update({ where: { id: auth.workspaceId }, data: { name, updatedBy: auth.userId }, select: { id: true, name: true } });
  emitToWorkspace(auth.workspaceId, 'workspace:renamed', workspace); // teammates' open apps show the new name
  return workspace;
}

// Only into workspaces the user is a member of; anything else reads as "not found"
export async function switchWorkspace({ userId }: AuthPayload, workspaceId: string) {
  const member = await prisma.member.findUnique({ where: { userId_workspaceId: { userId, workspaceId } } });
  if (!member) throw notFound('Workspace');
  return { token: signToken({ userId, workspaceId }), userId };
}
