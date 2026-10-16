import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { signToken } from '../auth.js';
import { env } from '../env.js';
import { disconnectUser } from '../realtime.js';
import { prisma } from '../prisma.js';
import { AppError } from './errors.js';
import { readJoinLink } from './joinLinks.js';
import { DEFAULT_ROLE } from './roles.js';
import { parse } from './validate.js';

const email = z.string().trim().toLowerCase().email('Enter a valid email');

// One rule for sign-up, password reset and admin-set passwords: 8-72 characters with a letter and a number
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password is too long')
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Password must include at least one letter and one number');

export const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  email,
  password: passwordSchema,
  // Without a team signup link: the new workspace this person will own (the original sign-up flow)
  workspaceName: z.string().trim().min(1, 'Workspace name is required').optional(),
  // With a team signup link: join that workspace as an Agent. There is deliberately no role field.
  joinToken: z.string().min(1).optional(),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Password is required'),
  // The workspace to open (the browser remembers the last one used); ignored unless the user is a member
  workspaceId: z.string().min(1).max(64).optional().nullable(),
});

// Simple in-memory limiter: 10 failed logins per IP per 15 minutes.
// Use Redis instead if you run more than one API instance.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;
const failures = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string) {
  const entry = failures.get(ip);
  if (entry && entry.resetAt > Date.now() && entry.count >= MAX_FAILS)
    throw new AppError('Too many login attempts. Try again later.', 429, 'RATE_LIMITED');
}

function recordFailure(ip: string) {
  const entry = failures.get(ip);
  if (!entry || entry.resetAt <= Date.now()) failures.set(ip, { count: 1, resetAt: Date.now() + WINDOW_MS });
  else entry.count++;
}

// Compared against when the email doesn't exist, so response time doesn't reveal registered emails
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 10);

export async function register(input: unknown) {
  const { name, email, password, workspaceName, joinToken } = parse(registerSchema, input);
  const joining = joinToken ? await readJoinLink(joinToken) : null;
  if (!joining && !env.allowWorkspaceCreation)
    throw new AppError('Sign-ups are by invitation only. Ask an admin to add you from the Teams page.', 403, 'REGISTRATION_CLOSED');
  if (!joining && !workspaceName) throw new AppError('Workspace name is required', 400, 'BAD_USER_INPUT');
  const membership = joining
    ? { role: DEFAULT_ROLE, workspaceId: joining.id }
    : { role: 'owner', workspace: { create: { name: workspaceName! } } };
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    // An account removed from every workspace is nobody's any more: the same email registers again by reusing
    // that row (so old messages and history still name the same person) with the new name and password.
    const orphan = await findOrphanAccount(email);
    const user = orphan
      ? await prisma.user.update({
          where: { id: orphan.id },
          data: { name, passwordHash, passwordChangedAt: new Date(), updatedBy: orphan.id, resetTokens: { deleteMany: {} }, members: { create: membership } },
          include: { members: true },
        })
      : await prisma.user.create({ data: { name, email, passwordHash, members: { create: membership } }, include: { members: true } });
    // Self sign-up: the person is their own creator (and of the workspace they just made)
    await prisma.user.update({ where: { id: user.id }, data: { createdBy: user.createdBy ?? user.id, members: { updateMany: { where: { workspaceId: user.members[0].workspaceId }, data: { createdBy: user.id } } } } });
    if (!joining) await prisma.workspace.update({ where: { id: user.members[0].workspaceId }, data: { createdBy: user.id } });
    return { token: signToken({ userId: user.id, workspaceId: user.members[0].workspaceId }), userId: user.id };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
      throw new AppError('Email already registered', 409, 'EMAIL_TAKEN');
    throw err;
  }
}

// The account for this email, if it has been removed from every workspace (and so can be taken over by a new
// sign-up or an admin re-adding the email). null when the email is unused or still belongs to a workspace.
export async function findOrphanAccount(email: string) {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, _count: { select: { members: true } } } });
  return user && user._count.members === 0 ? { id: user.id } : null;
}

export async function login(input: unknown, ip: string) {
  checkRateLimit(ip);
  const { email, password, workspaceId } = parse(loginSchema, input);
  const user = await prisma.user.findUnique({ where: { email }, include: { members: { orderBy: { id: 'asc' } } } });
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) {
    recordFailure(ip);
    throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
  }
  failures.delete(ip);
  // The requested workspace if they belong to it, otherwise the first one they joined. Workspaces where an
  // admin deactivated them don't count: with none left, the sign-in is refused.
  const active = user.members.filter((m) => m.active);
  const member = active.find((m) => m.workspaceId === workspaceId) ?? active[0];
  if (!member) {
    if (user.members.length)
      throw new AppError('This account has been deactivated. Ask an admin to reactivate it.', 403, 'ACCOUNT_INACTIVE');
    throw new AppError('This account has no workspace', 403, 'NO_WORKSPACE');
  }
  return { token: signToken({ userId: user.id, workspaceId: member.workspaceId }), userId: user.id };
}

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword: passwordSchema,
});

// Signed-in users change their own password (e.g. away from the default an admin gave them). Needs the current
// password, stores only the new hash, signs out every other session and returns a fresh token for this one.
export async function changePassword(auth: { userId: string; workspaceId: string }, input: unknown) {
  const { currentPassword, newPassword } = parse(changePasswordSchema, input);
  const user = await prisma.user.findUnique({ where: { id: auth.userId }, select: { passwordHash: true } });
  if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash)))
    throw new AppError('Current password is incorrect', 401, 'INVALID_CREDENTIALS');
  if (currentPassword === newPassword) throw new AppError('Choose a different password from the current one', 400, 'BAD_USER_INPUT');
  await prisma.user.update({
    where: { id: auth.userId },
    data: { passwordHash: await bcrypt.hash(newPassword, 10), passwordChangedAt: new Date(), updatedBy: auth.userId, resetTokens: { deleteMany: {} } },
  });
  await disconnectUser(auth.userId); // every tab reconnects with the new token
  return { token: signToken(auth), userId: auth.userId };
}

export async function getMe(auth: { userId: string; workspaceId: string }) {
  const [user, workspace] = await Promise.all([
    prisma.user.findUnique({ where: { id: auth.userId }, select: { id: true, name: true, email: true, phone: true, jobTitle: true, timeZone: true, avatarUpdatedAt: true, qrMessage: true } }),
    prisma.workspace.findUnique({
      where: { id: auth.workspaceId },
      include: { whatsapp: { select: { displayPhone: true, phoneNumberId: true, wabaId: true } } },
    }),
  ]);
  if (!user || !workspace) throw new AppError('Unauthorized', 401, 'UNAUTHENTICATED');
  return { user, workspace };
}
