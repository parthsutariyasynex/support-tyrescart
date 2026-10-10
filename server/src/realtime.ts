import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { verifyCurrentToken } from './auth.js';
import { env } from './env.js';
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
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });
  registerTyping(io);
}

// Drop a user's live connections in every workspace (e.g. after a password reset); their old token can't reconnect
export async function disconnectUser(userId: string) {
  if (!io) return;
  for (const socket of await io.fetchSockets()) if (socket.data.userId === userId) socket.disconnect(true);
}

export function emitToWorkspace(workspaceId: string, event: string, data: unknown) {
  io?.to(workspaceId).emit(event, data);
}
