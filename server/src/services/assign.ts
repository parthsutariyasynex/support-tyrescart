import { Prisma } from '@prisma/client';
import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToUser, emitToWorkspace } from '../realtime.js';
import { AppError, notFound } from './errors.js';
import { recordActivity } from './activity.js';
import { requireConversation } from './inbox.js';
import { getPermissions } from './permissions.js';
import { ASSIGNABLE_TO_ROLES, ROLE_COLORS } from './roles.js';

// A conversation is assigned to a workspace member: Conversation.assignedToId is a Member.id. The API and the
// Socket.IO payloads keep the "assignee" shape clients already use: id = the member id, name = the person's name,
// colour = their role colour, userId = their user id. There is no separate assignee table any more.
export const assigneeInclude = {
  user: { select: { id: true, name: true, email: true } },
  _count: { select: { assignedConversations: true } },
} as const;
export type AssigneeMember = Prisma.MemberGetPayload<{ include: typeof assigneeInclude }>;
type AssigneeRefMember = { id: string; role: string; user: { id: string; name: string } };

const roleColor = (role: string) => ROLE_COLORS[role] ?? ROLE_COLORS.agent;

export function toAssignee(m: AssigneeMember) {
  return {
    ...toAssigneeRef(m),
    role: m.role,
    active: m.active,
    conversationCount: m._count.assignedConversations,
    user: { id: m.user.id, name: m.user.name, email: m.user.email, role: m.role },
  };
}

// Nested in a conversation and in events: no count (the resolver counts on demand)
export function toAssigneeRef(m: AssigneeRefMember) {
  return { id: m.id, name: m.user.name, color: roleColor(m.role), userId: m.user.id };
}

// Everyone active in the current workspace (the Assign menu's people): name, email and role. Deactivated
// members are left out, so they can't be given chats.
export async function listWorkspaceMembers(workspaceId: string) {
  const members = await prisma.member.findMany({ where: { workspaceId, active: true }, include: { user: { select: { id: true, name: true, email: true } } } });
  return members
    .map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email, role: m.role }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The Assign list: every active member as an "assignee" (with how many chats they hold), sorted by name
export async function listAssignees(workspaceId: string) {
  const rows = await prisma.member.findMany({ where: { workspaceId, active: true }, include: assigneeInclude });
  return rows.map(toAssignee).sort((a, b) => a.name.localeCompare(b.name));
}

// A member of this workspace by member id or by user id, who may hold chats: current, active, assignable role
async function requireAssignableMember(workspaceId: string, where: { id: string } | { userId: string }) {
  const member = await prisma.member.findFirst({ where: { workspaceId, ...where }, include: assigneeInclude });
  if (!member || !member.active) throw notFound('Member'); // removed, deactivated, or never in this workspace
  if (!(ASSIGNABLE_TO_ROLES as readonly string[]).includes(member.role))
    throw new AppError('Chats can be assigned to supervisors and agents', 400, 'NOT_ASSIGNABLE');
  return member;
}

// Tells every open tab that a member's assignee shape changed (name, role colour, active)
export async function announceAssignee(workspaceId: string, memberId: string) {
  const member = await prisma.member.findFirst({ where: { id: memberId, workspaceId }, include: assigneeInclude });
  if (member) emitToWorkspace(workspaceId, 'assignee:saved', toAssignee(member));
}

// The member was removed between our check and the write (foreign key / missing row)
function missingMember(err: unknown) {
  if (err instanceof Prisma.PrismaClientKnownRequestError && ['P2003', 'P2025'].includes(err.code)) return notFound('Member');
  return err;
}

// Assigning a chat to a person by their user id (the Assign dropdown lists people). Admins only; the rest of the
// rules are in assignConversation.
export async function assignConversationToMember(auth: AuthPayload, conversationId: string, userId: string) {
  const { workspaceId } = auth;
  await requireConversation(workspaceId, conversationId);
  if (!(await getPermissions(auth)).canManageAssignments)
    throw new AppError('Only admins can assign or unassign chats. Use Assign to Me on New Leads.', 403, 'FORBIDDEN');
  const member = await requireAssignableMember(workspaceId, { userId });
  return assignConversation(workspaceId, conversationId, member.id, auth.userId);
}

// "Assign to Me" on a New Lead: take an unassigned chat for yourself. The write only applies while the chat is
// still unassigned (compare-and-set), so when two people click at the same moment exactly one gets it and the
// other is told who has it. Nobody's role changes; the chat simply moves to your My Chats.
export async function claimConversation(auth: AuthPayload, conversationId: string) {
  const { workspaceId, userId } = auth;
  await getPermissions(auth); // a current member of this workspace (any role)
  const conversation = await requireConversation(workspaceId, conversationId);
  if (conversation.assignedToId) {
    const own = await prisma.member.findUnique({ where: { userId_workspaceId: { userId, workspaceId } }, select: { id: true } });
    if (conversation.assignedToId === own?.id) return conversation; // already yours
    throw await alreadyAssigned(conversation.assignedToId);
  }
  const member = await requireAssignableMember(workspaceId, { userId });
  return assignConversation(workspaceId, conversationId, member.id, userId, { claim: true });
}

async function alreadyAssigned(memberId: string) {
  const m = await prisma.member.findUnique({ where: { id: memberId }, include: { user: { select: { name: true } } } });
  return new AppError(`This chat was already taken by ${m?.user.name ?? 'someone else'}.`, 409, 'ALREADY_ASSIGNED');
}

const ASSIGN_ATTEMPTS = 3;

// Pass null to unassign. `actorId` is the person doing it (history and notifications).
// Compare-and-set: the write only applies if the chat still has the member we just read, so when two admins
// reassign at once each history entry names the real previous holder. Assigning the current holder changes
// nothing, so it sends no event and records no history.
export async function assignConversation(
  workspaceId: string,
  conversationId: string,
  memberId: string | null,
  actorId: string | null = null,
  // claim: "Assign to Me" on a New Lead (the caller checked it's the actor's own membership); succeeds only while
  // the chat is still unassigned, for every role
  options: { claim?: boolean } = {},
) {
  const member = memberId ? await requireAssignableMember(workspaceId, { id: memberId }) : null;
  // Owners and admins assign, reassign and unassign. Everyone else (supervisors and agents) can only "Assign to
  // Me" an unassigned chat (claimConversation). getPermissions also refuses non-members.
  if (actorId && !options.claim && !(await getPermissions({ userId: actorId, workspaceId })).canManageAssignments)
    throw new AppError('Only admins can assign or unassign chats. Use Assign to Me on New Leads.', 403, 'FORBIDDEN');
  for (let attempt = 0; attempt < ASSIGN_ATTEMPTS; attempt++) {
    const before = await requireConversation(workspaceId, conversationId);
    if (before.assignedToId === memberId) return before;
    if (options.claim && before.assignedToId !== null) throw await alreadyAssigned(before.assignedToId);
    // Whoever holds it now (may be deactivated; a removed member can't, the chat was unassigned with them)
    const previous = before.assignedToId
      ? await prisma.member.findUnique({ where: { id: before.assignedToId }, include: { user: { select: { id: true, name: true } } } })
      : null;
    const { count } = await prisma.conversation
      .updateMany({
        where: { id: conversationId, workspaceId, assignedToId: before.assignedToId },
        data: { assignedToId: memberId, ...(actorId ? { updatedBy: actorId } : {}) },
      })
      .catch((err) => {
        throw missingMember(err);
      });
    if (count === 0) continue; // changed by someone else in between: read it again

    const payload = member && toAssigneeRef(member);
    emitToWorkspace(workspaceId, 'conversation:assigned', { conversationId, assignee: payload });
    await recordActivity({
      workspaceId,
      conversationId,
      actorId,
      type: !member ? 'unassigned' : previous ? 'reassigned' : 'assigned',
      data: member
        ? {
            assignee: member.user.name,
            color: roleColor(member.role),
            ...(previous ? { previous: previous.user.name } : {}),
            assigneeUserId: member.user.id,
          }
        : { assignee: previous?.user.name ?? null },
    });
    // Tell the people affected, unless they did it themselves: the new holder gets assignment:you; whoever it
    // was taken from gets assignment:removed
    const notifyNew = member && member.user.id !== actorId ? member.user.id : null;
    const notifyPrevious = previous && previous.user.id !== actorId ? previous.user.id : null;
    if (notifyNew || notifyPrevious) {
      const actor = actorId ? await prisma.user.findUnique({ where: { id: actorId }, select: { name: true } }) : null;
      const event = {
        conversationId,
        assignee: payload,
        actorName: actor?.name ?? null,
        contactName: before.contact.name || `+${before.contact.waId}`,
      };
      if (notifyNew) emitToUser(workspaceId, notifyNew, 'assignment:you', event);
      if (notifyPrevious) emitToUser(workspaceId, notifyPrevious, 'assignment:removed', { ...event, previous: previous!.user.name });
    }
    return requireConversation(workspaceId, conversationId);
  }
  throw new AppError('Someone else changed the assignee at the same time. Try again.', 409, 'ASSIGN_CONFLICT');
}
