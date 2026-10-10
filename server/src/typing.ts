import type { Server, Socket } from 'socket.io';
import { prisma } from './prisma.js';

// Live "Agent is typing…" between agents. This is the one event clients send over Socket.IO, so nothing
// in it is trusted: who is typing comes from the socket's verified token, the name from the database,
// and the conversation must belong to the socket's workspace. (WhatsApp doesn't tell businesses when
// a customer is typing, so only agents' typing can be shown.)

const MAX_EVENTS_PER_10S = 30; // clients send ~1 every 2.5s while typing; anything far above is dropped

type TypingEvent = { conversationId: string; userId: string; name: string; typing: boolean };

// Registered as middleware (after the auth middleware has set socket.data) so each socket gets its
// own typing handler; listeners added here stay attached once the connection completes.
export function registerTyping(io: Server) {
  io.use((socket: Socket, next) => {
    attachTyping(socket);
    next();
  });
}

function attachTyping(socket: Socket) {
  const { userId, workspaceId } = socket.data as { userId: string; workspaceId: string };
  const allowed = new Set<string>(); // conversations already checked to be in this workspace
  const active = new Set<string>(); // conversations this socket is currently typing in
  let name: string | null = null;
  let windowStart = Date.now();
  let count = 0;

  const broadcast = (conversationId: string, typing: boolean) => {
    const event: TypingEvent = { conversationId, userId, name: name ?? 'Someone', typing };
    socket.to(workspaceId).emit('typing', event); // everyone in the workspace except this socket
  };

  socket.on('typing', async (payload: unknown) => {
    if (Date.now() - windowStart > 10_000) {
      windowStart = Date.now();
      count = 0;
    }
    if (++count > MAX_EVENTS_PER_10S) return;

    const { conversationId, typing } = (payload ?? {}) as { conversationId?: unknown; typing?: unknown };
    if (typeof conversationId !== 'string' || conversationId.length > 64 || typeof typing !== 'boolean') return;

    if (!allowed.has(conversationId)) {
      const ok = await prisma.conversation.findFirst({
        where: { id: conversationId, workspaceId },
        select: { id: true },
      });
      if (!ok) return; // someone else's conversation, or made up
      allowed.add(conversationId);
    }
    if (name === null) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
      name = user?.name ?? 'Someone';
    }
    if (typing) active.add(conversationId);
    else active.delete(conversationId);
    broadcast(conversationId, typing);
  });

  // Closing the tab or losing connection mid-sentence shouldn't leave "typing…" behind
  socket.on('disconnect', () => {
    for (const conversationId of active) broadcast(conversationId, false);
  });
}
