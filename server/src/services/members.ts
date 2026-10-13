import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { signToken, type AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { disconnectMember, emitToWorkspace } from '../realtime.js';
import { registerSchema } from './auth.js';
import { recordActivity } from './activity.js';
import { AppError, notFound } from './errors.js';
import { isInviteToken, sendInvite } from './passwordReset.js';
import { announcePermissions, requireAdmin } from './permissions.js';
import { readJoinLink, signJoinLink } from './joinLinks.js';
import { ASSIGNABLE_ROLES, DEFAULT_ROLE } from './roles.js';
import { parse } from './validate.js';

// Team management (admins only): who is in the workspace and with which role. A person has one User
// (one email, one password) and one Member row per workspace, so adding an existing account to another
// workspace never duplicates the user.

const roleSchema = z.enum(ASSIGNABLE_ROLES, { message: 'Role must be admin, supervisor or agent' });
const inviteSchema = z.object({
  name: registerSchema.shape.name.max(191, 'Name is too long'),
  email: registerSchema.shape.email,
  role: roleSchema,
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
const memberStatus = (u: MemberRow['user']) => (!u.passwordChangedAt && u.resetTokens.some(isInviteToken) ? 'invited' : 'active');
const toMember = (m: MemberRow) => ({
  userId: m.user.id,
  name: m.user.name,
  email: m.user.email,
  role: m.role,
  isOwner: m.role === 'owner',
  canManageLabels: m.canManageLabels,
  status: memberStatus(m.user),
});

export async function listMembers(auth: AuthPayload) {
  await requireAdmin(auth);
  const rows = await prisma.member.findMany({ where: { workspaceId: auth.workspaceId }, include: memberInclude });
  return rows.map(toMember).sort((a, b) => a.name.localeCompare(b.name));
}

// New email: creates the account and emails a link to choose a password. Existing email: adds that account
// to this workspace (its name and password are untouched). Already a member: refused.
export async function inviteMember(auth: AuthPayload, rawInput: unknown) {
  await requireAdmin(auth);
  const { workspaceId } = auth;
  const { name, email, role } = parse(inviteSchema, rawInput);

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  let member: MemberRow;
  let invited = false;
  let emailSent = true;
  try {
    if (existing) {
      member = await prisma.member.create({ data: { userId: existing.id, workspaceId, role }, include: memberInclude });
    } else {
      // Nobody knows this password; the invite link sets the real one
      const passwordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 10);
      const user = await prisma.user.create({
        data: { name, email, passwordHash, members: { create: { workspaceId, role } } },
        include: { members: { where: { workspaceId }, include: memberInclude } },
      });
      member = user.members[0];
      invited = true;
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

  if (invited) {
    const [workspace, inviter] = await Promise.all([
      prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }),
      prisma.user.findUnique({ where: { id: auth.userId }, select: { name: true } }),
    ]);
    emailSent = await sendInvite(member.user, workspace?.name ?? 'your team', inviter?.name ?? 'An admin');
    member = await prisma.member.findUniqueOrThrow({ where: { id: member.id }, include: memberInclude }); // now "invited"
  }
  await announcePermissions(workspaceId, member.user.id);
  return { member: toMember(member), invited, emailSent };
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

// Only admins promote or demote, and never the owner or themselves (so a workspace can't lose its last admin)
export async function updateMemberRole(auth: AuthPayload, userId: string, rawRole: unknown) {
  await requireAdmin(auth);
  const role = parse(roleSchema, rawRole);
  const member = await requireOtherMember(auth, userId, 'change the role of');
  const updated = await prisma.member.update({ where: { id: member.id }, data: { role }, include: memberInclude });
  await announcePermissions(auth.workspaceId, userId);
  return toMember(updated);
}

// Their account stays (they may be in other workspaces); they lose access to this one immediately. Their name
// leaves the Assign list too: the assignee linked to them is deleted and any chats it held become unassigned
// (New Leads), each with a history entry, exactly like deleting an assignee.
export async function removeMember(auth: AuthPayload, userId: string) {
  await requireAdmin(auth);
  const { workspaceId } = auth;
  const member = await requireOtherMember(auth, userId, 'remove');
  const dropped = await prisma.$transaction(async (tx) => {
    const assignees = await tx.assignee.findMany({ where: { workspaceId, userId }, select: { id: true, name: true } });
    const chats = assignees.length
      ? await tx.conversation.findMany({ where: { workspaceId, assignedToId: { in: assignees.map((a) => a.id) } }, select: { id: true, assignedToId: true } })
      : [];
    await tx.assignee.deleteMany({ where: { workspaceId, userId } }); // chats fall back to unassigned (onDelete: SetNull)
    await tx.member.delete({ where: { id: member.id } });
    return { assignees, chats };
  });
  disconnectMember(workspaceId, userId);
  emitToWorkspace(workspaceId, 'member:removed', { userId });
  for (const a of dropped.assignees) emitToWorkspace(workspaceId, 'assignee:deleted', { id: a.id });
  for (const c of dropped.chats)
    await recordActivity({
      workspaceId,
      conversationId: c.id,
      actorId: auth.userId,
      type: 'unassigned',
      data: { assignee: dropped.assignees.find((a) => a.id === c.assignedToId)?.name ?? member.user.name, reason: 'member_removed' },
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
    create: { userId: auth.userId, workspaceId: workspace.id, role: DEFAULT_ROLE },
  });
  await announcePermissions(workspace.id, auth.userId);
  return { token: signToken({ userId: auth.userId, workspaceId: workspace.id }), userId: auth.userId };
}
