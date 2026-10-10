import { z } from 'zod';
import { signToken, type AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { notFound } from './errors.js';
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
  const { name } = parse(createSchema, rawInput);
  const workspace = await prisma.workspace.create({
    data: { name, members: { create: { userId, role: 'owner' } } },
  });
  return { token: signToken({ userId, workspaceId: workspace.id }), userId };
}

// Only into workspaces the user is a member of; anything else reads as "not found"
export async function switchWorkspace({ userId }: AuthPayload, workspaceId: string) {
  const member = await prisma.member.findUnique({ where: { userId_workspaceId: { userId, workspaceId } } });
  if (!member) throw notFound('Workspace');
  return { token: signToken({ userId, workspaceId }), userId };
}
