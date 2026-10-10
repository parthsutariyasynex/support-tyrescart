import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { AppError, notFound } from './errors.js';

const ADMIN_ROLES = ['owner', 'admin'];

export async function getPermissions({ userId, workspaceId }: AuthPayload) {
  const member = await prisma.member.findUnique({ where: { userId_workspaceId: { userId, workspaceId } } });
  const role = member?.role ?? 'agent';
  const isAdmin = ADMIN_ROLES.includes(role);
  return { role, canManageLabels: isAdmin || !!member?.canManageLabels, isAdmin };
}

// Creating, renaming, recolouring or deleting labels and assignees. Using them (assigning) is open to everyone.
export async function requireLabelManager(auth: AuthPayload) {
  if (!(await getPermissions(auth)).canManageLabels)
    throw new AppError("You don't have permission to manage labels", 403, 'FORBIDDEN');
}

// Owners and admins grant or revoke label management for a member
export async function setLabelPermission(auth: AuthPayload, userId: string, canManageLabels: boolean) {
  if (!(await getPermissions(auth)).isAdmin)
    throw new AppError('Only owners and admins can change permissions', 403, 'FORBIDDEN');
  const where = { userId_workspaceId: { userId, workspaceId: auth.workspaceId } };
  if (!(await prisma.member.findUnique({ where }))) throw notFound('Member');
  await prisma.member.update({ where, data: { canManageLabels } });
  const permissions = await getPermissions({ userId, workspaceId: auth.workspaceId });
  emitToWorkspace(auth.workspaceId, 'member:permissions', { userId, ...permissions });
  return { userId, role: permissions.role, canManageLabels: permissions.canManageLabels };
}
