import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { signToken, type AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { disconnectMember, disconnectUser, emitToWorkspace } from '../realtime.js';
import { findOrphanAccount, passwordSchema, registerSchema } from './auth.js';
import { recordActivity } from './activity.js';
import { recordAssignment } from './assignmentReports.js';
import { announceAssignee } from './assign.js';
import { AppError, notFound } from './errors.js';
import { isInviteToken, sendAccountReady, sendInvite } from './passwordReset.js';
import { announcePermissions, requireAdmin } from './permissions.js';
import { readJoinLink, signJoinLink } from './joinLinks.js';
import { ASSIGNABLE_ROLES, DEFAULT_ROLE, isAdminRole } from './roles.js';
import { parse } from './validate.js';

// Team management (admins only): who is in the workspace and with which role. A person has one User
// (one email, one password) and one Member row per workspace, so adding an existing account to another
// workspace never duplicates the user.

const roleSchema = z.enum(ASSIGNABLE_ROLES, { message: 'Role must be admin, supervisor or agent' });
const inviteSchema = z.object({
  name: registerSchema.shape.name.max(191, 'Name is too long'),
  email: registerSchema.shape.email,
  role: roleSchema,
  // Optional first password set by the admin; without it, an invite email asks the person to choose one
  password: passwordSchema.optional(),
});
const updateSchema = z.object({
  name: registerSchema.shape.name.max(191, 'Name is too long').optional(),
  password: passwordSchema.optional(),
});

// Status (Teams tab), from existing data only: "invited" is someone an admin added who hasn't chosen a password
// yet (their invite link is still unused and they never set one); everyone else is "active" and can sign in.
const memberInclude = {
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      passwordChangedAt: true,
      resetTokens: { where: { usedAt: null }, select: { createdAt: true, expiresAt: true } },
    },
  },
} as const;
type MemberRow = Prisma.MemberGetPayload<{ include: typeof memberInclude }>;
// "inactive" (deactivated here by an admin) wins over the account-level invited/active. "invited": an unused
// invite link newer than the last password change (a re-invited account gets its old password voided first).
const memberStatus = (m: MemberRow) => {
  if (!m.active) return 'inactive';
  const since = m.user.passwordChangedAt?.getTime() ?? 0;
  return m.user.resetTokens.some((t) => isInviteToken(t) && t.createdAt.getTime() >= since) ? 'invited' : 'active';
};
const toMember = (m: MemberRow) => ({
  userId: m.user.id,
  name: m.user.name,
  email: m.user.email,
  role: m.role,
  isOwner: m.role === 'owner',
  canManageLabels: m.canManageLabels,
  active: m.active,
  status: memberStatus(m),
});

export async function listMembers(auth: AuthPayload) {
  await requireAdmin(auth);
  const rows = await prisma.member.findMany({ where: { workspaceId: auth.workspaceId }, include: memberInclude });
  return rows.map(toMember).sort((a, b) => a.name.localeCompare(b.name));
}

// New email: creates the account with the admin's password (they can sign in at once) or, without one, emails a
// link to choose a password. An email whose account was removed from every workspace counts as new again: that
// row is reused (same user id, so old history still names them) with the new name and password. Existing email
// still in some workspace: adds that account here with its own name and password untouched (an admin can't set a
// password for an account that belongs elsewhere). Already a member: refused. Only the bcrypt hash is ever
// stored; the API has no field that returns a password.
export async function inviteMember(auth: AuthPayload, rawInput: unknown) {
  await requireAdmin(auth);
  const { workspaceId } = auth;
  const { name, email, role, password } = parse(inviteSchema, rawInput);

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing && (await prisma.member.findUnique({ where: { userId_workspaceId: { userId: existing.id, workspaceId } } })))
    throw new AppError('This person is already a member of this workspace', 409, 'MEMBER_EXISTS');
  const orphan = existing ? await findOrphanAccount(email) : null;
  if (existing && !orphan && password !== undefined)
    throw new AppError(
      'This email already has an account (it is a member of another workspace), so its password can only be changed by that person. Add them without a password: they keep their current one.',
      409,
      'ACCOUNT_EXISTS',
    );
  let member: MemberRow;
  let invited = false;
  let created = false;
  let emailSent = true;
  try {
    if (existing && !orphan) {
      member = await prisma.member.create({ data: { userId: existing.id, workspaceId, role, createdBy: auth.userId }, include: memberInclude });
    } else {
      // Without an admin-set password, nobody knows this one; the invite link sets the real one
      const passwordHash = await bcrypt.hash(password ?? randomBytes(32).toString('hex'), 10);
      const include = { members: { where: { workspaceId }, include: memberInclude } };
      const user = orphan
        ? await prisma.user.update({
            where: { id: orphan.id },
            data: { name, passwordHash, passwordChangedAt: new Date(), updatedBy: auth.userId, resetTokens: { deleteMany: {} }, members: { create: { workspaceId, role, createdBy: auth.userId } } },
            include,
          })
        : await prisma.user.create({ data: { name, email, passwordHash, createdBy: auth.userId, members: { create: { workspaceId, role, createdBy: auth.userId } } }, include });
      member = user.members[0];
      created = true;
      invited = password === undefined;
    }
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
      throw new AppError(
        existing ? 'This person is already a member of this workspace' : 'An account with this email was just created. Try again.',
        409,
        existing ? 'MEMBER_EXISTS' : 'EMAIL_TAKEN',
      );
    throw err;
  }

  const [workspace, inviter] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }),
    prisma.user.findUnique({ where: { id: auth.userId }, select: { name: true } }),
  ]);
  if (invited) {
    // No password set: the email carries a "choose your password" link
    emailSent = await sendInvite(member.user, workspace?.name ?? 'your team', inviter?.name ?? 'An admin');
    member = await prisma.member.findUniqueOrThrow({ where: { id: member.id }, include: memberInclude }); // now "invited"
  } else {
    // Account created with an admin-set password, or an existing account added: email the login link (and the
    // temporary password when the admin set one just now)
    emailSent = await sendAccountReady(member.user, workspace?.name ?? 'your team', inviter?.name ?? 'An admin', created && password !== undefined ? password : null);
  }
  await announcePermissions(workspaceId, member.user.id);
  return { member: toMember(member), invited, emailSent, created };
}

// Admins edit a member's name or set them a new password. Only the hash is stored, and a new password signs
// that person out everywhere (like a reset) so the old sessions die. The owner's account is only the owner's
// to change, and your own password isn't set here (use Forgot password).
export async function updateMember(auth: AuthPayload, userId: string, rawInput: unknown) {
  await requireAdmin(auth);
  const { name, password } = parse(updateSchema, rawInput);
  const where = { userId_workspaceId: { userId, workspaceId: auth.workspaceId } };
  const member = await prisma.member.findUnique({ where, include: memberInclude });
  if (!member) throw notFound('Member');
  if (member.role === 'owner' && userId !== auth.userId)
    throw new AppError("The workspace owner's account can only be changed by the owner", 400, 'OWNER_PROTECTED');
  if (password !== undefined && userId === auth.userId)
    throw new AppError("You can't set your own password here. Use Forgot password.", 400, 'CANNOT_CHANGE_SELF');
  if (name === undefined && password === undefined) return toMember(member);
  await prisma.user.update({
    where: { id: userId },
    data: {
      updatedBy: auth.userId,
      ...(name !== undefined ? { name } : {}),
      ...(password !== undefined ? { passwordHash: await bcrypt.hash(password, 10), passwordChangedAt: new Date() } : {}),
    },
  });
  if (password !== undefined) await disconnectUser(userId);
  await announcePermissions(auth.workspaceId, userId); // the new name reaches the team list and the Assign menu
  if (name !== undefined) await announceAssignee(auth.workspaceId, member.id);
  return toMember(await prisma.member.findUniqueOrThrow({ where, include: memberInclude }));
}

// Deactivate: they can't sign in to this workspace, their current token and Socket.IO connections to it stop at
// once, and they can't be assigned chats. Nothing is deleted: their chats, history and assignee stay, and
// reactivating restores everything. Never the owner or yourself.
export async function setMemberActive(auth: AuthPayload, userId: string, active: boolean) {
  await requireAdmin(auth);
  const member = await requireOtherMember(auth, userId, active ? 'reactivate' : 'deactivate');
  if (member.active === active) return toMember(member);
  if (!active && isAdminRole(member.role)) await requireAnotherActiveAdmin(auth.workspaceId, userId, 'deactivate');
  const updated = await prisma.member.update({ where: { id: member.id }, data: { active, updatedBy: auth.userId }, include: memberInclude });
  if (!active) disconnectMember(auth.workspaceId, userId);
  await announcePermissions(auth.workspaceId, userId);
  // Deactivated: out of the Assign list (their chats keep them until reassigned); reactivated: back in it
  if (active) await announceAssignee(auth.workspaceId, member.id);
  else emitToWorkspace(auth.workspaceId, 'assignee:deleted', { id: member.id });
  return toMember(updated);
}

async function requireOtherMember(auth: AuthPayload, userId: string, action: string) {
  if (userId === auth.userId) throw new AppError(`You can't ${action} yourself`, 400, 'CANNOT_CHANGE_SELF');
  const member = await prisma.member.findUnique({
    where: { userId_workspaceId: { userId, workspaceId: auth.workspaceId } },
    include: memberInclude,
  });
  if (!member) throw notFound('Member');
  if (member.role === 'owner')
    throw new AppError("The workspace owner can't be changed or removed", 400, 'OWNER_PROTECTED');
  return member;
}

// A workspace must always keep at least one active admin (the owner counts), or nobody could manage it. The
// owner can't be changed and nobody acts on themselves, so this normally can't trigger; it's the backstop for
// odd states (e.g. a request racing with the actor's own deactivation).
async function requireAnotherActiveAdmin(workspaceId: string, exceptUserId: string, action: string) {
  const others = await prisma.member.count({
    where: { workspaceId, active: true, role: { in: ['owner', 'admin'] }, userId: { not: exceptUserId } },
  });
  if (others === 0) throw new AppError(`You can't ${action} the last active admin`, 400, 'LAST_ADMIN');
}

// Only admins promote or demote, and never the owner or themselves (so a workspace can't lose its last admin)
export async function updateMemberRole(auth: AuthPayload, userId: string, rawRole: unknown) {
  await requireAdmin(auth);
  const role = parse(roleSchema, rawRole);
  const member = await requireOtherMember(auth, userId, 'change the role of');
  if (isAdminRole(member.role) && !isAdminRole(role) && member.active) await requireAnotherActiveAdmin(auth.workspaceId, userId, 'demote');
  const updated = await prisma.member.update({ where: { id: member.id }, data: { role, updatedBy: auth.userId }, include: memberInclude });
  await announcePermissions(auth.workspaceId, userId);
  await announceAssignee(auth.workspaceId, member.id); // new role colour in chats and the Assign list
  return toMember(updated);
}

// Their account stays (they may be in other workspaces); they lose access to this one immediately. Their name
// leaves the Assign list too, and any chats they held become unassigned (New Leads; onDelete: SetNull), each
// with a history entry.
export async function removeMember(auth: AuthPayload, userId: string) {
  await requireAdmin(auth);
  const { workspaceId } = auth;
  const member = await requireOtherMember(auth, userId, 'remove');
  if (isAdminRole(member.role) && member.active) await requireAnotherActiveAdmin(workspaceId, userId, 'remove');
  const actor = await prisma.user.findUnique({ where: { id: auth.userId }, select: { id: true, name: true } });
  const chats = await prisma.$transaction(async (tx) => {
    const held = await tx.conversation.findMany({ where: { workspaceId, assignedToId: member.id }, select: { id: true } });
    await tx.member.delete({ where: { id: member.id } });
    // Each released chat gets an assignment report row (unassigned by the admin, no reason)
    for (const c of held)
      await recordAssignment(tx, { workspaceId, conversationId: c.id, previous: member, next: null, actor, reason: null });
    return held;
  });
  disconnectMember(workspaceId, userId);
  emitToWorkspace(workspaceId, 'member:removed', { userId });
  emitToWorkspace(workspaceId, 'assignee:deleted', { id: member.id });
  for (const c of chats)
    await recordActivity({
      workspaceId,
      conversationId: c.id,
      actorId: auth.userId,
      type: 'unassigned',
      data: { assignee: member.user.name, reason: 'member_removed' },
    });
  return userId;
}

export async function createJoinLink(auth: AuthPayload) {
  await requireAdmin(auth);
  return signJoinLink(auth.workspaceId);
}

// Public: lets the signup page say which workspace you're joining
export async function joinLinkInfo(token: unknown) {
  const { name } = await readJoinLink(token);
  return { workspaceName: name };
}

// A signed-in user with an existing account opens a signup link: add them as an Agent (or, if they're
// already a member, keep their current role) and hand back a token for that workspace
export async function joinWorkspace(auth: AuthPayload, token: unknown) {
  const workspace = await readJoinLink(token);
  await prisma.member.upsert({
    where: { userId_workspaceId: { userId: auth.userId, workspaceId: workspace.id } },
    update: {},
    create: { userId: auth.userId, workspaceId: workspace.id, role: DEFAULT_ROLE, createdBy: auth.userId },
  });
  await announcePermissions(workspace.id, auth.userId);
  return { token: signToken({ userId: auth.userId, workspaceId: workspace.id }), userId: auth.userId };
}
