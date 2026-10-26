import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { AppError, notFound } from './errors.js';
import { logEvent } from './logging.js';
import { isAdminRole, isSupervisorOrAbove } from './roles.js';

// Someone tried something their role doesn't allow: logged (WARNING) and returned as the error to throw
function denied(auth: AuthPayload, action: string, message: string, role?: string) {
  void logEvent({
    level: 'WARNING',
    category: 'permission',
    event: 'permission.denied',
    message: `Refused: ${action}`,
    direction: 'in',
    outcome: 'refused',
    reason: `Someone with the role "${role ?? 'none'}" tried to ${action}, which their role doesn't allow`,
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    errorCode: 'FORBIDDEN',
    errorDetails: message,
    data: { action, role: role ?? null },
  });
  return new AppError(message, 403, 'FORBIDDEN');
}

// Always read from the database, so role changes apply on the next request (no re-login needed).
// Someone who isn't a member of the workspace has no permissions at all.
export async function getPermissions({ userId, workspaceId }: AuthPayload) {
  const member = await prisma.member.findUnique({ where: { userId_workspaceId: { userId, workspaceId } } });
  if (!member) throw denied({ userId, workspaceId }, 'not a member of this workspace', 'You are not a member of this workspace');
  const role = member.role;
  const isAdmin = isAdminRole(role);
  // Assigning, reassigning and unassigning chats: owners, admins and supervisors. Agents never; they only take an
  // unassigned chat for themselves with "Assign to Me" (claimConversation).
  const canManageAssignments = isSupervisorOrAbove(role);
  // Labels and assignee names/colours: admins and supervisors, or anyone an admin granted it to (unchanged)
  const canManageLabels = isSupervisorOrAbove(role) || member.canManageLabels;
  return { role, isAdmin, canManageAssignments, canManageLabels };
}

// Users, roles and system settings (WhatsApp connection)
export async function requireAdmin(auth: AuthPayload) {
  const { isAdmin, role } = await getPermissions(auth);
  if (!isAdmin) throw denied(auth, 'admin-only action', 'Only admins can do this', role);
}

// Creating, renaming, recolouring or deleting labels and assignees: supervisors and admins, or agents an
// admin has granted it to. Assignment rules are in assignConversation.
export async function requireLabelManager(auth: AuthPayload) {
  const { canManageLabels, role } = await getPermissions(auth);
  if (!canManageLabels) throw denied(auth, 'manage labels', "You don't have permission to manage labels", role);
}

// Assigning, reassigning and unassigning chats: owners, admins and supervisors (agents use Assign to Me)
export async function requireAssignmentManager(auth: AuthPayload) {
  const { canManageAssignments, role } = await getPermissions(auth);
  if (!canManageAssignments) throw denied(auth, 'manage assignments', 'Agents can only take unassigned chats with Assign to Me.', role);
}

// Owners and admins grant or revoke label management for a member
export async function setLabelPermission(auth: AuthPayload, userId: string, canManageLabels: boolean) {
  const { isAdmin, role } = await getPermissions(auth);
  if (!isAdmin) throw denied(auth, 'change permissions', 'Only owners and admins can change permissions', role);
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
