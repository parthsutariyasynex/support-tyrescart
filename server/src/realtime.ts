import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { verifyCurrentToken } from './auth.js';
import { env } from './env.js';
import { forgetPresence, registerPresence } from './presence.js';
import { logEvent } from './services/logging.js';
import { registerTyping } from './typing.js';

let io: Server;

// Each workspace gets its own room so agents only see their own inbox
export function initRealtime(server: HttpServer) {
  io = new Server(server, { cors: { origin: env.webOrigin } });
  io.use(async (socket, next) => {
    try {
      const { userId, workspaceId } = await verifyCurrentToken(socket.handshake.auth.token);
      socket.data.userId = userId;
      socket.data.workspaceId = workspaceId;
      socket.join(workspaceId);
      socket.join(userRoom(workspaceId, userId));
      next();
    } catch (err) {
      // Refused: no token, an expired one, or a removed member's (never the token itself)
      void logEvent({
        level: 'WARNING',
        category: 'socket',
        event: 'socket.unauthorized',
        message: `Live connection refused: ${(err as Error)?.message ?? 'invalid token'}`,
        direction: 'in',
        outcome: 'refused',
        reason: socket.handshake.auth?.token ? `A browser tried to connect with a sign-in that isn't valid any more (${(err as Error)?.message ?? 'invalid token'})` : 'A browser tried to connect without signing in',
        errorCode: 'UNAUTHORIZED',
        errorDetails: (err as Error)?.message ?? null,
        data: { socketId: socket.id, sentSignIn: !!socket.handshake.auth?.token, transport: socket.conn?.transport?.name ?? null },
      });
      next(new Error('Unauthorized'));
    }
  });
  // Connections and disconnections (to the day's log file: they're frequent)
  io.on('connection', (socket) => {
    const opened = Date.now();
    const who = { workspaceId: socket.data.workspaceId as string, userId: socket.data.userId as string };
    void logEvent({ ...who, level: 'SUCCESS', category: 'socket', event: 'socket.connected', message: 'Live connection opened', direction: 'in', outcome: 'connected', newStatus: 'connected', data: { socketId: socket.id, transport: socket.conn?.transport?.name ?? null }, fileOnly: true });
    socket.on('disconnect', (reason) =>
      void logEvent({ ...who, level: 'SUCCESS', category: 'socket', event: 'socket.disconnected', message: `Live connection closed: ${reason}`, reason: `The connection closed: ${reason} (e.g. "transport close" = the tab closed or the network dropped)`, direction: 'in', outcome: 'closed', previousStatus: 'connected', newStatus: 'disconnected', durationMs: Date.now() - opened, data: { socketId: socket.id, reason }, fileOnly: true }),
    );
    socket.on('error', (err) =>
      void logEvent({ ...who, level: 'ERROR', category: 'socket', event: 'socket.error', message: `Live connection error: ${err?.message ?? err}`, errorDetails: err?.message ?? String(err), data: { socketId: socket.id } }),
    );
  });
  registerTyping(io);
  registerPresence(io);
}

// Drop a user's live connections in every workspace (e.g. after a password reset); their old token can't reconnect
export async function disconnectUser(userId: string) {
  if (!io) return;
  for (const socket of await io.fetchSockets()) if (socket.data.userId === userId) socket.disconnect(true);
}

// Every event sent to the team (to the day's log file): its name, who it went to, and the ids in it (message,
// conversation) so it can be matched with what caused it. Never the payload itself (message text, names…).
// Typing and presence signals aren't sent through here (typing.ts, presence.ts) and aren't logged: they fire many
// times a second and carry nothing to trace.
// What each event tells the open apps (the reason it's sent)
const SOCKET_WHY: Record<string, string> = {
  'message:new': 'a new message in a chat',
  'message:status': "a sent message's delivery status changed",
  'message:updated': 'a message was edited, deleted, restored or reacted to',
  'chat:new': 'a new customer started a chat',
  'conversation:status': 'a chat was closed, reopened or snoozed',
  'conversation:assigned': 'a chat was assigned to someone else',
  'conversation:labels': "a chat's labels changed",
  'conversation:cleared': 'a chat was cleared for one person',
  'live:changed': 'a live location started, moved or ended',
  'notification:new': 'a new notification in the bell',
  'activity:new': "a new entry in a chat's history",
};

function idsOf(data: any) {
  const message = data?.message ?? (data?.direction && data?.conversationId ? data : null);
  return {
    messageId: message?.id ?? data?.messageId ?? null,
    waMessageId: message?.waMessageId ?? null,
    conversationId: message?.conversationId ?? data?.conversation?.id ?? data?.conversationId ?? null,
    status: message?.status ?? null,
  };
}

function logEmit(event: string, room: { workspaceId: string; userId?: string }, data: unknown) {
  const ids = idsOf(data);
  void logEvent({
    level: 'SUCCESS',
    category: 'socket',
    event: 'socket.emit',
    message: `Sent "${event}" to ${room.userId ? 'a teammate' : 'the workspace'}`,
    reason: `Tell ${room.userId ? "a teammate's" : "the team's"} open apps: ${SOCKET_WHY[event] ?? event}`,
    outcome: io ? 'sent' : 'skipped (live updates not started)',
    direction: 'out',
    workspaceId: room.workspaceId,
    messageId: ids.messageId,
    waMessageId: ids.waMessageId,
    conversationId: ids.conversationId,
    newStatus: ids.status,
    data: { socketEvent: event, ...(room.userId ? { toUserId: room.userId } : {}), delivered: !!io },
    fileOnly: true,
  });
}

export function emitToWorkspace(workspaceId: string, event: string, data: unknown) {
  io?.to(workspaceId).emit(event, data);
  logEmit(event, { workspaceId }, data);
}

// One user's connections in one workspace (all their tabs), e.g. "a chat was assigned to you"
const userRoom = (workspaceId: string, userId: string) => `${workspaceId}:user:${userId}`;

export function emitToUser(workspaceId: string, userId: string, event: string, data: unknown) {
  io?.to(userRoom(workspaceId, userId)).emit(event, data);
  logEmit(event, { workspaceId, userId }, data);
}

// Removed from a workspace: close their live connections to it (their token for it no longer works either)
export function disconnectMember(workspaceId: string, userId: string) {
  io?.in(userRoom(workspaceId, userId)).disconnectSockets(true);
  forgetPresence(workspaceId, userId);
}
