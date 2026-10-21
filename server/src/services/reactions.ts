import { z } from 'zod';
import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { sendReaction } from '../whatsapp.js';
import { AppError, notFound } from './errors.js';
import { checkCanSend } from './inbox.js';
import { getPermissions } from './permissions.js';
import { withSender } from './senders.js';
import { parse } from './validate.js';

// Reactions, as in WhatsApp: the customer can react to any message (it arrives on the webhook), and the business
// can react with one emoji per message (the team shares the business number, so the latest teammate's reaction
// is the business's). Everyone with the chat open sees them change live (message:updated).

// One emoji (with skin tone / ZWJ sequences); '' or null removes
const emojiSchema = z
  .string()
  .trim()
  .max(32, 'Choose one emoji')
  .refine((v) => !v || /^\p{Extended_Pictographic}/u.test(v) || /^\p{Regional_Indicator}{2}$/u.test(v) || /^[#*0-9]️?⃣$/u.test(v), 'Choose an emoji')
  .nullable();

const broadcast = async (workspaceId: string, message: Parameters<typeof withSender>[0]) => emitToWorkspace(workspaceId, 'message:updated', await withSender(message));

// The business reacts (or removes its reaction with null/''): sent to WhatsApp first, saved when it succeeds
export async function reactToMessage(auth: AuthPayload, messageId: string, rawEmoji: unknown) {
  await getPermissions(auth);
  const emoji = parse(emojiSchema, rawEmoji ?? null) || null;
  const message = await prisma.message.findFirst({ where: { id: messageId, conversation: { workspaceId: auth.workspaceId } } });
  if (!message) throw notFound('Message');
  if (message.deletedAt) throw new AppError("Deleted messages can't get reactions", 400, 'BAD_USER_INPUT');
  if (!message.waMessageId) throw new AppError("This message didn't go through WhatsApp, so it can't get a reaction", 400, 'BAD_USER_INPUT');
  if ((message.teamReaction ?? null) === emoji) return message;
  // Same rules as replying: the chat is open, within WhatsApp's 24-hour window, and you may write in it
  const { conversation, account } = await checkCanSend(auth.workspaceId, message.conversationId, auth.userId, true);
  try {
    await sendReaction(account, conversation.contact.waId, message.waMessageId, emoji ?? '');
  } catch (err) {
    // WhatsApp's own reason (e.g. an expired access token), so the person sees why
    throw new AppError(`WhatsApp didn't accept the reaction: ${(err as Error).message}`, 502, 'WHATSAPP_ERROR');
  }
  const saved = await prisma.message.update({
    where: { id: messageId },
    data: { teamReaction: emoji, teamReactionById: emoji ? auth.userId : null, updatedBy: auth.userId },
  });
  await broadcast(auth.workspaceId, saved);
  return saved;
}

// A customer's reaction from the webhook ({ message_id, emoji }; an empty emoji = they removed it). Returns false
// when the message it's for isn't in this workspace (e.g. older than this app), so nothing is stored.
export async function applyCustomerReaction(workspaceId: string, reaction: { message_id?: unknown; emoji?: unknown } | undefined) {
  const target = typeof reaction?.message_id === 'string' ? reaction.message_id : '';
  if (!target) return false;
  const message = await prisma.message.findFirst({ where: { waMessageId: target, conversation: { workspaceId } } });
  if (!message) return false;
  const emoji = typeof reaction?.emoji === 'string' && reaction.emoji.trim() ? reaction.emoji.trim().slice(0, 32) : null;
  const saved = await prisma.message.update({ where: { id: message.id }, data: { customerReaction: emoji } });
  await broadcast(workspaceId, saved);
  return true;
}
