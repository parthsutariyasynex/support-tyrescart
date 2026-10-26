// Location messages, like WhatsApp's: a pin (latitude/longitude) with an optional place name and address, sent
// with Meta's "location" message type (received from customers the same way, see messages.ts). Stored as
// locationFormat.ts describes.
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { sendLocation } from '../whatsapp.js';
import { previewOf, recordActivity } from './activity.js';
import { checkCanSend, replyTarget } from './inbox.js';
import { locationBody, oneLine, roundCoord } from './locationFormat.js';
import { logMessageSend } from './logging.js';
import { withSender } from './senders.js';
import { parse } from './validate.js';

export const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  name: z.string().trim().max(200).nullish(),
  address: z.string().trim().max(500).nullish(),
  replyToId: z.string().min(1).nullish(),
});

// Sends a location pin to the customer (inside the 24-hour window, like any message that isn't a template)
export async function sendLocationMessage(workspaceId: string, conversationId: string, rawInput: unknown, sentById?: string) {
  const input = parse(locationSchema, rawInput);
  const { conversation, account } = await checkCanSend(workspaceId, conversationId, sentById, true);
  const quoted = await replyTarget(conversationId, input.replyToId);
  const place = { latitude: roundCoord(input.latitude), longitude: roundCoord(input.longitude), name: oneLine(input.name) || null, address: oneLine(input.address) || null };
  const body = locationBody(place);
  const message = await prisma.message.create({
    data: { conversationId, direction: 'out', type: 'location', body, status: 'pending', sentById, replyToId: quoted?.id ?? null },
  });
  let saved;
  let sendError: unknown;
  try {
    const wamid = await sendLocation(account, conversation.contact.waId, place, quoted?.waMessageId);
    saved = await prisma.message.update({ where: { id: message.id }, data: { waMessageId: wamid, status: 'sent' } });
  } catch (err) {
    saved = await prisma.message.update({ where: { id: message.id }, data: { status: 'failed', error: (err as Error).message } });
    sendError = err;
  }
  logMessageSend({ workspaceId, conversationId, messageId: message.id, type: 'location', userId: sentById, error: sendError, waMessageId: saved.waMessageId });
  await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date(), ...(sentById ? { updatedBy: sentById } : {}) } });
  emitToWorkspace(workspaceId, 'message:new', { conversation, message: await withSender(saved) });
  await recordActivity({
    workspaceId,
    conversationId,
    actorId: sentById ?? null,
    type: 'message_sent',
    data: { preview: previewOf(`📍 ${place.name || place.address || 'Location'}`, 200), messageType: 'location', status: saved.status },
  });
  return saved;
}
