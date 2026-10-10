import { z } from 'zod';
import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { AppError, notFound } from './errors.js';
import { recordActivity } from './activity.js';
import { getPermissions } from './permissions.js';
import { withSender } from './senders.js';
import { parse } from './validate.js';

// Edit / "delete for everyone" for messages the team sent.
// Note: the WhatsApp Cloud API can't edit or unsend a message the customer already received,
// so these change the message for everyone using this app; the customer's phone keeps the original.

const editSchema = z.object({
  body: z.string().trim().min(1, 'Message cannot be empty').max(4096, 'Message is too long'),
  // The version the editor started from; a mismatch means someone else changed it meanwhile
  version: z.number().int().min(0),
});
const deleteSchema = z.object({ version: z.number().int().min(0).optional() });

const conflict = () =>
  new AppError(
    'This message was changed by someone else. Check the latest version and try again.',
    409,
    'EDIT_CONFLICT',
  );

// The message must be in the caller's workspace, sent by the team, and theirs (owners/admins may change any)
async function requireEditable(auth: AuthPayload, messageId: string) {
  const message = await prisma.message.findFirst({
    where: { id: messageId, conversation: { workspaceId: auth.workspaceId } },
  });
  if (!message) throw notFound('Message');
  if (message.direction !== 'out') throw new AppError("Customer messages can't be edited or deleted", 403, 'FORBIDDEN');
  const { isAdmin } = await getPermissions(auth);
  if (!isAdmin && message.sentById !== auth.userId)
    throw new AppError('You can only edit or delete your own messages', 403, 'FORBIDDEN');
  return message;
}

// Edits/deletes keep the original sender (sentById never changes), so the name goes along unchanged
async function broadcast(
  workspaceId: string,
  message: { id: string; direction: string; sentById: string | null; conversationId: string },
) {
  emitToWorkspace(workspaceId, 'message:updated', await withSender(message));
}

export async function editMessage(auth: AuthPayload, messageId: string, rawInput: unknown) {
  const { body, version } = parse(editSchema, rawInput);
  const message = await requireEditable(auth, messageId);
  if (message.deletedAt) throw new AppError('This message was deleted', 409, 'MESSAGE_DELETED');
  if (message.type !== 'text') throw new AppError('Only text messages can be edited', 400, 'NOT_EDITABLE');
  if (message.version !== version) throw conflict();
  if (message.body === body) return message;

  // Compare-and-set on version so two simultaneous edits can't both win
  const updated = await prisma.$transaction(async (tx) => {
    const { count } = await tx.message.updateMany({
      where: { id: messageId, version, deletedAt: null },
      data: { body, editedAt: new Date(), version: { increment: 1 } },
    });
    if (count === 0) throw conflict();
    await tx.messageRevision.create({ data: { messageId, body: message.body, action: 'edit', userId: auth.userId } });
    return tx.message.findUniqueOrThrow({ where: { id: messageId } });
  });
  await broadcast(auth.workspaceId, updated);
  await recordActivity({
    workspaceId: auth.workspaceId,
    conversationId: updated.conversationId,
    actorId: auth.userId,
    type: 'message_edited',
    data: { messageId },
  });
  return updated;
}

// Idempotent: deleting an already-deleted message returns it unchanged
export async function deleteMessage(auth: AuthPayload, messageId: string, rawInput: unknown = {}) {
  const { version } = parse(deleteSchema, rawInput);
  const message = await requireEditable(auth, messageId);
  if (message.deletedAt) return message;
  if (version !== undefined && message.version !== version) throw conflict();

  const updated = await prisma.$transaction(async (tx) => {
    const { count } = await tx.message.updateMany({
      where: { id: messageId, version: message.version, deletedAt: null },
      data: { body: '', deletedAt: new Date(), deletedById: auth.userId, version: { increment: 1 } },
    });
    if (count === 0) {
      const current = await tx.message.findUniqueOrThrow({ where: { id: messageId } });
      if (current.deletedAt) return current; // someone else deleted it first
      throw conflict();
    }
    await tx.messageRevision.create({ data: { messageId, body: message.body, action: 'delete', userId: auth.userId } });
    return tx.message.findUniqueOrThrow({ where: { id: messageId } });
  });
  await broadcast(auth.workspaceId, updated);
  // Only when this call did the delete (someone else may have deleted it a moment earlier)
  if (updated.deletedById === auth.userId && updated.version === message.version + 1)
    await recordActivity({
      workspaceId: auth.workspaceId,
      conversationId: updated.conversationId,
      actorId: auth.userId,
      type: 'message_deleted',
      data: { messageId },
    });
  return updated;
}

// Undo for "delete for everyone", like WhatsApp's Undo toast. The app offers it for a few seconds;
// the server allows a little longer to cover slow networks.
export const UNDO_WINDOW_MS = 60_000;
const restoreSchema = z.object({ version: z.number().int().min(0) });

export async function restoreMessage(auth: AuthPayload, messageId: string, rawInput: unknown) {
  const { version } = parse(restoreSchema, rawInput);
  const message = await requireEditable(auth, messageId);
  if (!message.deletedAt) throw new AppError("This message isn't deleted", 409, 'NOT_DELETED');
  if (message.deletedById !== auth.userId)
    throw new AppError('Only the person who deleted this message can undo it', 403, 'FORBIDDEN');
  if (Date.now() - message.deletedAt.getTime() > UNDO_WINDOW_MS)
    throw new AppError('Too late to undo this delete', 409, 'UNDO_EXPIRED');
  if (message.version !== version) throw conflict();

  // The text it had just before it was deleted
  const deletion = await prisma.messageRevision.findFirst({
    where: { messageId, action: 'delete' },
    orderBy: { createdAt: 'desc' },
  });
  if (!deletion) throw new AppError("This message can't be restored", 409, 'NOT_RESTORABLE');

  const updated = await prisma.$transaction(async (tx) => {
    const { count } = await tx.message.updateMany({
      where: { id: messageId, version, deletedAt: { not: null } },
      data: { body: deletion.body, deletedAt: null, deletedById: null, version: { increment: 1 } },
    });
    if (count === 0) throw conflict();
    await tx.messageRevision.create({
      data: { messageId, body: deletion.body, action: 'restore', userId: auth.userId },
    });
    return tx.message.findUniqueOrThrow({ where: { id: messageId } });
  });
  await broadcast(auth.workspaceId, updated);
  await recordActivity({
    workspaceId: auth.workspaceId,
    conversationId: updated.conversationId,
    actorId: auth.userId,
    type: 'message_restored',
    data: { messageId },
  });
  return updated;
}
