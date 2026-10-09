import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { verifyToken } from './auth.js';
import { env } from './env.js';

let io: Server;

// Each workspace gets its own room so agents only see their own inbox
export function initRealtime(server: HttpServer) {
  io = new Server(server, { cors: { origin: env.webOrigin } });
  io.use((socket, next) => {
    try {
      const { workspaceId } = verifyToken(socket.handshake.auth.token);
      socket.join(workspaceId);
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });
}

export function emitToWorkspace(workspaceId: string, event: string, data: unknown) {
  io?.to(workspaceId).emit(event, data);
}
