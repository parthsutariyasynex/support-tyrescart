// Live location, for 15 minutes, 1 hour or 8 hours. WhatsApp's Business API can't send a live location, so the
// customer gets a normal message with a private link; the link opens a page (routes/live.ts) with the teammate's
// position on a map, following it as it moves until the time is up or the teammate stops sharing. The teammate's
// browser sends the position while sharing (navigator.geolocation in the open app).
// Kept in memory only (no database changes): a server restart ends every live location. The message itself stays.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AuthPayload } from '../auth.js';
import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { sendText } from '../whatsapp.js';
import { recordActivity } from './activity.js';
import { AppError, notFound } from './errors.js';
import { checkCanSend } from './inbox.js';
import { roundCoord } from './locationFormat.js';
import { logMessageSend } from './logging.js';
import { getPermissions } from './permissions.js';
import { withSender } from './senders.js';
import { parse } from './validate.js';
import { settingsOf } from './workspaceSettings.js';

export const LIVE_MINUTES = [15, 60, 480] as const;
const KEEP_ENDED_MS = 24 * 60 * 60_000; // an ended share still says "ended" on its page for a day, then is forgotten

type Position = { latitude: number; longitude: number; accuracy: number | null; at: Date };
type Share = {
  token: string;
  workspaceId: string;
  conversationId: string;
  messageId: string;
  userId: string;
  sharerName: string;
  startedAt: Date;
  until: Date;
  stoppedAt: Date | null;
  position: Position | null;
};

const shares = new Map<string, Share>(); // by token
const tokenOfMessage = new Map<string, string>();

const isActive = (s: Share, now = Date.now()) => !s.stoppedAt && s.until.getTime() > now;

// What the team sees about a live location (its card in the chat)
export function liveInfo(s: Share) {
  return {
    messageId: s.messageId,
    conversationId: s.conversationId,
    userId: s.userId,
    sharerName: s.sharerName,
    startedAt: s.startedAt,
    until: s.until,
    stoppedAt: s.stoppedAt,
    active: isActive(s),
    position: s.position,
  };
}

const announce = (s: Share) => emitToWorkspace(s.workspaceId, 'live:changed', liveInfo(s));

const positionSchema = {
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100_000).nullish(),
};
const startSchema = z.object({
  conversationId: z.string().min(1),
  minutes: z.number().refine((m) => (LIVE_MINUTES as readonly number[]).includes(m), 'Share for 15 minutes, 1 hour or 8 hours'),
  ...positionSchema,
});
const updateSchema = z.object(positionSchema);

const position = (p: { latitude: number; longitude: number; accuracy?: number | null }): Position => ({
  latitude: roundCoord(p.latitude),
  longitude: roundCoord(p.longitude),
  accuracy: p.accuracy == null ? null : Math.round(p.accuracy),
  at: new Date(),
});

// "14:30 GMT+4": when sharing ends, in the workspace's time zone
function clock(at: Date, timeZone: string) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(at);
  } catch {
    return `${at.toISOString().slice(11, 16)} UTC`;
  }
}

export async function startLiveLocation(auth: AuthPayload, rawInput: unknown) {
  const input = parse(startSchema, rawInput);
  const { conversation, account } = await checkCanSend(auth.workspaceId, input.conversationId, auth.userId, true);
  // One live location per person per chat: starting again ends the earlier one
  for (const s of shares.values())
    if (s.userId === auth.userId && s.conversationId === input.conversationId && isActive(s)) {
      s.stoppedAt = new Date();
      announce(s);
    }
  const user = await prisma.user.findUnique({ where: { id: auth.userId }, select: { name: true } });
  const sharerName = user?.name?.trim() || 'Our team';
  const now = new Date();
  const until = new Date(now.getTime() + input.minutes * 60_000);
  const token = randomBytes(18).toString('base64url');
  const timeZone = (await settingsOf(auth.workspaceId)).defaultTimeZone;
  const body = `📍 Live location: ${sharerName} is sharing their location with you until ${clock(until, timeZone)}.\nFollow it on the map: ${env.publicAppUrl}/live/${token}`;

  const message = await prisma.message.create({
    data: { conversationId: input.conversationId, direction: 'out', type: 'live_location', body, status: 'pending', sentById: auth.userId },
  });
  const share: Share = { token, workspaceId: auth.workspaceId, conversationId: input.conversationId, messageId: message.id, userId: auth.userId, sharerName, startedAt: now, until, stoppedAt: null, position: position(input) };
  shares.set(token, share);
  tokenOfMessage.set(message.id, token);

  let saved;
  let sendError: unknown;
  try {
    const wamid = await sendText(account, conversation.contact.waId, body);
    saved = await prisma.message.update({ where: { id: message.id }, data: { waMessageId: wamid, status: 'sent' } });
  } catch (err) {
    saved = await prisma.message.update({ where: { id: message.id }, data: { status: 'failed', error: (err as Error).message } });
    sendError = err;
    share.stoppedAt = new Date(); // the customer never got the link
  }
  logMessageSend({ workspaceId: auth.workspaceId, conversationId: input.conversationId, messageId: message.id, type: 'live_location', userId: auth.userId, error: sendError });
  await prisma.conversation.update({ where: { id: input.conversationId }, data: { lastMessageAt: new Date(), updatedBy: auth.userId } });
  emitToWorkspace(auth.workspaceId, 'message:new', { conversation, message: await withSender(saved) });
  announce(share);
  await recordActivity({
    workspaceId: auth.workspaceId,
    conversationId: input.conversationId,
    actorId: auth.userId,
    type: 'message_sent',
    data: { preview: `📍 Live location (${input.minutes >= 60 ? `${input.minutes / 60} h` : `${input.minutes} min`})`, messageType: 'live_location', status: saved.status },
  });
  return { message: saved, live: liveInfo(share) };
}

function shareOf(workspaceId: string, messageId: string) {
  const token = tokenOfMessage.get(messageId);
  const share = token ? shares.get(token) : undefined;
  return share && share.workspaceId === workspaceId ? share : null;
}

// The sharer's browser sends where they are now. Only while sharing; only the person sharing.
export function updateLiveLocation(auth: AuthPayload, messageId: string, rawInput: unknown) {
  const share = shareOf(auth.workspaceId, messageId);
  if (!share) throw notFound('Live location');
  if (share.userId !== auth.userId) throw new AppError('Only the person sharing can update this live location', 403, 'FORBIDDEN');
  if (!isActive(share)) throw new AppError('This live location has ended', 409, 'LIVE_ENDED');
  share.position = position(parse(updateSchema, rawInput));
  announce(share);
  return liveInfo(share);
}

// Stop sharing: the person sharing, or an admin
export async function stopLiveLocation(auth: AuthPayload, messageId: string) {
  const share = shareOf(auth.workspaceId, messageId);
  if (!share) throw notFound('Live location');
  if (share.userId !== auth.userId && !(await getPermissions(auth)).isAdmin)
    throw new AppError('Only the person sharing (or an admin) can stop this live location', 403, 'FORBIDDEN');
  if (isActive(share)) {
    share.stoppedAt = new Date();
    announce(share);
  }
  return liveInfo(share);
}

// The live location of a message, for its card (null: unknown, e.g. after a server restart: shown as ended)
export function getLiveLocation(auth: AuthPayload, messageId: string) {
  const share = shareOf(auth.workspaceId, messageId);
  return share ? liveInfo(share) : null;
}

// The team's own live locations still running, so the app can keep sending positions after a reload
export function myActiveLiveLocations(auth: AuthPayload) {
  return [...shares.values()].filter((s) => s.workspaceId === auth.workspaceId && s.userId === auth.userId && isActive(s)).map(liveInfo);
}

// The public page behind the link: only the position while sharing, and when it ends. Never the chat, the
// customer or anything else of the workspace.
export function publicLiveLocation(token: string) {
  const share = shares.get(token);
  if (!share) return null;
  const active = isActive(share);
  return {
    active,
    sharerName: share.sharerName,
    until: share.until,
    endedAt: active ? null : (share.stoppedAt ?? share.until),
    position: active ? share.position : null,
  };
}

// Forgets live locations that ended over a day ago (their pages then say the link isn't valid)
export function sweepLiveLocations(now = Date.now()) {
  for (const [token, s] of shares) {
    const ended = s.stoppedAt?.getTime() ?? s.until.getTime();
    if (!isActive(s, now) && now - ended > KEEP_ENDED_MS) {
      shares.delete(token);
      tokenOfMessage.delete(s.messageId);
    }
  }
}

export function startLiveLocationSweeper(intervalMs = 10 * 60_000) {
  const timer = setInterval(() => sweepLiveLocations(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// Tests only
export function resetLiveLocations() {
  shares.clear();
  tokenOfMessage.clear();
}
export const tokenForMessage = (messageId: string) => tokenOfMessage.get(messageId) ?? null;
