import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { AppError, notFound } from './errors.js';
import { isAdminRole, isSupervisorOrAbove } from './roles.js';

// Always read from the database, so role changes apply on the next request (no re-login needed).
// Someone who isn't a member of the workspace has no permissions at all.
export async function getPermissions({ userId, workspaceId }: AuthPayload) {
  const member = await prisma.member.findUnique({ where: { userId_workspaceId: { userId, workspaceId } } });
  if (!member) throw new AppError('You are not a member of this workspace', 403, 'FORBIDDEN');
  const role = member.role;
  const isAdmin = isAdminRole(role);
  // Assigning, reassigning and unassigning chats is open to every role (owner, admin, supervisor and agent):
  // being a current member of the workspace is the only requirement (checked above). The flag is kept so the
  // API, the member:permissions event and the clients keep their shape; it is true for every member.
  const canManageAssignments = true;
  // Labels and assignee names/colours: admins and supervisors, or anyone an admin granted it to (unchanged)
  const canManageLabels = isSupervisorOrAbove(role) || member.canManageLabels;
  return { role, isAdmin, canManageAssignments, canManageLabels };
}

// Users, roles and system settings (WhatsApp connection)
export async function requireAdmin(auth: AuthPayload) {
  if (!(await getPermissions(auth)).isAdmin) throw new AppError('Only admins can do this', 403, 'FORBIDDEN');
}

// Creating, renaming, recolouring or deleting labels and assignees: supervisors and admins, or agents an
// admin has granted it to. Assignment rules are in assignConversation.
export async function requireLabelManager(auth: AuthPayload) {
  if (!(await getPermissions(auth)).canManageLabels)
    throw new AppError("You don't have permission to manage labels", 403, 'FORBIDDEN');
}

// Assigning, reassigning and unassigning chats: any current member of the workspace, whatever their role
export async function requireAssignmentManager(auth: AuthPayload) {
  if (!(await getPermissions(auth)).canManageAssignments)
    throw new AppError("You don't have permission to assign chats", 403, 'FORBIDDEN');
}

// Owners and admins grant or revoke label management for a member
export async function setLabelPermission(auth: AuthPayload, userId: string, canManageLabels: boolean) {
  if (!(await getPermissions(auth)).isAdmin)
    throw new AppError('Only owners and admins can change permissions', 403, 'FORBIDDEN');
  const where = { userId_workspaceId: { userId, workspaceId: auth.workspaceId } };
  if (!(await prisma.member.findUnique({ where }))) throw notFound('Member');
  await prisma.member.update({ where, data: { canManageLabels, updatedBy: auth.userId } });
  return announcePermissions(auth.workspaceId, userId);
}

// Tells every open tab in the workspace about a member's current role and permissions
export async function announcePermissions(workspaceId: string, userId: string) {
  const { role, canManageLabels, canManageAssignments } = await getPermissions({ userId, workspaceId });
  emitToWorkspace(workspaceId, 'member:permissions', { userId, role, canManageLabels, canManageAssignments });
  return { userId, role, canManageLabels, canManageAssignments };
}
