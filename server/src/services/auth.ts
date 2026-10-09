import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { signToken } from '../auth.js';
import { prisma } from '../prisma.js';
import { AppError } from './errors.js';
import { parse } from './validate.js';

const email = z.string().trim().toLowerCase().email('Enter a valid email');

export const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  email,
  password: z.string().min(8, 'Password must be at least 8 characters').max(72, 'Password is too long'),
  workspaceName: z.string().trim().min(1, 'Workspace name is required'),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Password is required'),
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
  const { name, email, password, workspaceName } = parse(registerSchema, input);
  try {
    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash: await bcrypt.hash(password, 10),
        members: { create: { role: 'owner', workspace: { create: { name: workspaceName } } } },
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
  const { email, password } = parse(loginSchema, input);
  const user = await prisma.user.findUnique({ where: { email }, include: { members: true } });
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) {
    recordFailure(ip);
    throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
  }
  failures.delete(ip);
  const member = user.members[0];
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
