import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from './env.js';
import { prisma } from './prisma.js';

export type AuthPayload = { userId: string; workspaceId: string };

declare global {
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

export function signToken(payload: AuthPayload) {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: '7d' });
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, env.jwtSecret) as AuthPayload;
}

// verifyToken + rejects tokens issued before the user's last password reset (so a reset signs out every
// existing session) and tokens for a workspace the user is no longer a member of (removed by an admin).
// Used for every API request and Socket.IO connection.
export async function verifyCurrentToken(token: string): Promise<AuthPayload> {
  const payload = jwt.verify(token, env.jwtSecret) as AuthPayload & { iat?: number; purpose?: string };
  // Other signed tokens (e.g. team signup links) are never sign-ins
  if (payload.purpose || typeof payload.userId !== 'string' || typeof payload.workspaceId !== 'string')
    throw new Error('Not a sign-in token');
  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { passwordChangedAt: true, members: { where: { workspaceId: payload.workspaceId }, select: { id: true } } },
  });
  if (!user) throw new Error('User no longer exists');
  if (user.passwordChangedAt && (payload.iat ?? 0) < Math.floor(user.passwordChangedAt.getTime() / 1000))
    throw new Error('Signed out by a password reset');
  if (user.members.length === 0) throw new Error('No longer a member of this workspace');
  return { userId: payload.userId, workspaceId: payload.workspaceId };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    req.auth = await verifyCurrentToken(token);
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
