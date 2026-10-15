import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToUser, emitToWorkspace } from '../realtime.js';
import { recordActivity } from './activity.js';
import { AppError, notFound } from './errors.js';
import { requireConversation } from './inbox.js';
import { getPermissions } from './permissions.js';

// Collaborators on a chat: teammates added alongside the assignee. They get the chat's notifications (bell).
// Every role (owner, admin, supervisor, agent) can add and remove collaborators and see who they are.

export const MAX_COLLABORATORS = 20;

export async function listCollaborators(workspaceId: string, conversationId: string) {
  await requireConversation(workspaceId, conversationId);
  const rows = await prisma.conversationCollaborator.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } });
  if (!rows.length) return [];
  const members = await prisma.member.findMany({
    where: { workspaceId, userId: { in: rows.map((r) => r.userId) } },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  // A collaborator who has since left the workspace is not shown
  return rows
    .map((r) => members.find((m) => m.userId === r.userId))
    .filter((m): m is NonNullable<typeof m> => !!m)
    .map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email, role: m.role }));
}

// Any current member of the workspace (every role); getPermissions refuses outsiders and removed members
async function requireCollaboratorManager(auth: AuthPayload, _conversationId: string) {
  await getPermissions(auth);
}

const announce = async (workspaceId: string, conversationId: string) =>
  emitToWorkspace(workspaceId, 'conversation:collaborators', { conversationId, collaborators: await listCollaborators(workspaceId, conversationId) });

export async function addCollaborators(auth: AuthPayload, conversationId: string, userIds: string[]) {
  await requireConversation(auth.workspaceId, conversationId);
  await requireCollaboratorManager(auth, conversationId);
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) throw new AppError('Choose at least one person', 400, 'BAD_USER_INPUT');
  const members = await prisma.member.findMany({
    where: { workspaceId: auth.workspaceId, active: true, userId: { in: ids } },
    include: { user: { select: { name: true } } },
  });
  if (members.length !== ids.length) throw notFound('Member'); // someone not (or no longer) in this workspace
  const existing = await prisma.conversationCollaborator.findMany({ where: { conversationId }, select: { userId: true } });
  const fresh = members.filter((m) => !existing.some((e) => e.userId === m.userId));
  if (existing.length + fresh.length > MAX_COLLABORATORS)
    throw new AppError(`A chat can have up to ${MAX_COLLABORATORS} collaborators`, 400, 'COLLABORATOR_LIMIT');
  if (fresh.length) {
    await prisma.conversationCollaborator.createMany({ data: fresh.map((m) => ({ conversationId, userId: m.userId, addedById: auth.userId })), skipDuplicates: true });
    await recordActivity({
      workspaceId: auth.workspaceId,
      conversationId,
      actorId: auth.userId,
      type: 'collaborators_added',
      data: { names: fresh.map((m) => m.user.name), userIds: fresh.map((m) => m.userId) },
    });
    await announce(auth.workspaceId, conversationId);
    // Toast for each person just added (only them; never the person who added them). Names only.
    const [actor, chat] = await Promise.all([
      prisma.user.findUnique({ where: { id: auth.userId }, select: { name: true } }),
      prisma.conversation.findUnique({ where: { id: conversationId }, select: { contact: { select: { name: true, waId: true } } } }),
    ]);
    const contactName = chat ? chat.contact.name || `+${chat.contact.waId}` : '';
    for (const m of fresh)
      if (m.userId !== auth.userId)
        emitToUser(auth.workspaceId, m.userId, 'collaborator:you', { conversationId, actorName: actor?.name ?? null, contactName });
  }
  return listCollaborators(auth.workspaceId, conversationId);
}

export async function removeCollaborator(auth: AuthPayload, conversationId: string, userId: string) {
  await requireConversation(auth.workspaceId, conversationId);
  await requireCollaboratorManager(auth, conversationId);
  const { count } = await prisma.conversationCollaborator.deleteMany({ where: { conversationId, userId } });
  if (count) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    await recordActivity({ workspaceId: auth.workspaceId, conversationId, actorId: auth.userId, type: 'collaborator_removed', data: { name: user?.name ?? 'someone', userId } });
    await announce(auth.workspaceId, conversationId);
    // Toast for the person removed (only them; not when they removed themselves). Names only.
    if (userId !== auth.userId) {
      const [actor, chat] = await Promise.all([
        prisma.user.findUnique({ where: { id: auth.userId }, select: { name: true } }),
        prisma.conversation.findUnique({ where: { id: conversationId }, select: { contact: { select: { name: true, waId: true } } } }),
      ]);
      emitToUser(auth.workspaceId, userId, 'collaborator:removed', {
        conversationId,
        actorName: actor?.name ?? null,
        contactName: chat ? chat.contact.name || `+${chat.contact.waId}` : '',
      });
    }
  }
  return listCollaborators(auth.workspaceId, conversationId);
}
