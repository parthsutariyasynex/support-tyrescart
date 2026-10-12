import jwt from 'jsonwebtoken';
import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { AppError } from './errors.js';

// Team signup link: anyone with it can create an account (or add their existing one) as an Agent.
// Signed with the server secret, so it can't be forged or pointed at another workspace; expires after 7 days.
// Sign-in tokens are never accepted as signup links (and signup links never as sign-ins: see verifyCurrentToken).
const JOIN_PURPOSE = 'workspace-join';
const JOIN_TTL_S = 7 * 24 * 60 * 60;

export function signJoinLink(workspaceId: string) {
  const token = jwt.sign({ purpose: JOIN_PURPOSE, workspaceId }, env.jwtSecret, { expiresIn: JOIN_TTL_S });
  return { token, expiresAt: new Date(Date.now() + JOIN_TTL_S * 1000) };
}

const invalidLink = () =>
  new AppError('This signup link is invalid or has expired. Ask an admin for a new one.', 400, 'INVALID_JOIN_LINK');

// The workspace a signup link is for
export async function readJoinLink(token: unknown) {
  let payload: { purpose?: string; workspaceId?: string };
  try {
    payload = jwt.verify(String(token ?? ''), env.jwtSecret) as typeof payload;
  } catch {
    throw invalidLink();
  }
  if (payload.purpose !== JOIN_PURPOSE || !payload.workspaceId) throw invalidLink();
  const workspace = await prisma.workspace.findUnique({ where: { id: payload.workspaceId }, select: { id: true, name: true } });
  if (!workspace) throw invalidLink();
  return workspace;
}
