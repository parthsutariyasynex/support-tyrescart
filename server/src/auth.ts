import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from './env.js';
import { prisma } from './prisma.js';
import { setRequestUser } from './services/logging.js';

export type AuthPayload = { userId: string; workspaceId: string };

declare global {
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

// iatMs: when the token was issued, in milliseconds. JWT's own iat is whole seconds, which let a token issued in
// the same second as a password change survive that change.
export function signToken(payload: AuthPayload) {
  return jwt.sign({ ...payload, iatMs: Date.now() }, env.jwtSecret, { expiresIn: '7d' });
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, env.jwtSecret) as AuthPayload;
}

// verifyToken + rejects tokens issued before the user's last password change (so a reset, or an admin setting a
// new password, signs out every existing session) and tokens for a workspace the user is no longer an active
// member of (removed or deactivated by an admin). Used for every API request and Socket.IO connection.
export async function verifyCurrentToken(token: string): Promise<AuthPayload> {
  const payload = jwt.verify(token, env.jwtSecret) as AuthPayload & { iat?: number; iatMs?: number; purpose?: string };
  // Other signed tokens (e.g. team signup links) are never sign-ins
  if (payload.purpose || typeof payload.userId !== 'string' || typeof payload.workspaceId !== 'string')
    throw new Error('Not a sign-in token');
  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { passwordChangedAt: true, members: { where: { workspaceId: payload.workspaceId, active: true }, select: { id: true } } },
  });
  if (!user) throw new Error('User no longer exists');
  const issuedAt = typeof payload.iatMs === 'number' ? payload.iatMs : (payload.iat ?? 0) * 1000; // older tokens: seconds
  if (user.passwordChangedAt && issuedAt < user.passwordChangedAt.getTime()) throw new Error('Signed out by a password change');
  if (user.members.length === 0) throw new Error('Deactivated or no longer a member of this workspace');
  return { userId: payload.userId, workspaceId: payload.workspaceId };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    req.auth = await verifyCurrentToken(token);
    setRequestUser(req.auth); // later log entries of this request name the person and workspace
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
