import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { signToken } from '../auth.js';
import { prisma } from '../prisma.js';
import { AppError } from './errors.js';
import { readJoinLink } from './joinLinks.js';
import { DEFAULT_ROLE } from './roles.js';
import { parse } from './validate.js';

const email = z.string().trim().toLowerCase().email('Enter a valid email');

export const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  email,
  password: z.string().min(8, 'Password must be at least 8 characters').max(72, 'Password is too long'),
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
  if (!joining && !workspaceName) throw new AppError('Workspace name is required', 400, 'BAD_USER_INPUT');
  try {
    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash: await bcrypt.hash(password, 10),
        members: {
          create: joining
            ? { role: DEFAULT_ROLE, workspaceId: joining.id }
            : { role: 'owner', workspace: { create: { name: workspaceName! } } },
        },
      },
      include: { members: true },
    });
    return { token: signToken({ userId: user.id, workspaceId: user.members[0].workspaceId }), userId: user.id };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
      throw new AppError('Email already registered', 409, 'EMAIL_TAKEN');
    throw err;
  }
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
  // The requested workspace if they belong to it, otherwise the first one they joined
  const member = user.members.find((m) => m.workspaceId === workspaceId) ?? user.members[0];
  if (!member) throw new AppError('This account has no workspace', 403, 'NO_WORKSPACE');
  return { token: signToken({ userId: user.id, workspaceId: member.workspaceId }), userId: user.id };
}

export async function getMe(auth: { userId: string; workspaceId: string }) {
  const [user, workspace] = await Promise.all([
    prisma.user.findUnique({ where: { id: auth.userId }, select: { id: true, name: true, email: true } }),
    prisma.workspace.findUnique({
      where: { id: auth.workspaceId },
      include: { whatsapp: { select: { displayPhone: true, phoneNumberId: true, wabaId: true } } },
    }),
  ]);
  if (!user || !workspace) throw new AppError('Unauthorized', 401, 'UNAUTHENTICATED');
  return { user, workspace };
}
