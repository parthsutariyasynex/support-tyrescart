import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { env } from '../env.js';
import { sendMail } from '../mailer.js';
import { prisma } from '../prisma.js';
import { disconnectUser } from '../realtime.js';
import { registerSchema } from './auth.js';
import { AppError } from './errors.js';
import { parse } from './validate.js';
import { logFailure } from './logging.js';

// "Forgot password": email a single-use link that expires after 30 minutes.
// The response never says whether the email has an account.

const TOKEN_TTL_MS = 30 * 60 * 1000;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

// Limit how often links can be requested, per IP and per email (in memory, like the login limiter)
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_IP = 20;
const MAX_PER_EMAIL = 3;
const attempts = new Map<string, { count: number; resetAt: number }>();
function tooMany(key: string, max: number) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  return ++entry.count > max;
}

const requestSchema = z.object({ email: registerSchema.shape.email });
const resetSchema = z.object({
  token: z.string().min(20, 'This reset link is invalid').max(200, 'This reset link is invalid'),
  password: registerSchema.shape.password,
});

export async function requestPasswordReset(rawInput: unknown, ip: string) {
  const { email } = parse(requestSchema, rawInput);
  if (tooMany(`ip:${ip}`, MAX_PER_IP))
    throw new AppError('Too many reset requests. Try again later.', 429, 'RATE_LIMITED');
  // Per-email limit fails silently so it can't be used to tell which emails exist
  if (tooMany(`email:${email}`, MAX_PER_EMAIL)) return true;

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, name: true, email: true } });
  if (!user) return true;

  const token = randomBytes(32).toString('base64url');
  await prisma.$transaction([
    prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }), // only the newest link works
    prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hash(token), expiresAt: new Date(Date.now() + TOKEN_TTL_MS) },
    }),
  ]);

  // APP_URL is where people open the web app (e.g. https://support.example.com); falls back to WEB_ORIGIN
  const appUrl = (process.env.APP_URL || env.webOrigin).replace(/\/$/, '');
  const link = `${appUrl}/reset-password?token=${token}`;
  try {
    await sendMail({
      to: user.email,
      subject: `Reset your ${env.appName} password`,
      text: `Hi ${user.name},\n\nUse this link to choose a new password (valid for 30 minutes):\n${link}\n\nIf you didn't ask for this, you can ignore this email; your password won't change.`,
      html: `<p>Hi ${escapeHtml(user.name)},</p><p>Use this link to choose a new password (valid for 30 minutes):</p><p><a href="${link}">Reset password</a></p><p>If you didn't ask for this, you can ignore this email; your password won't change.</p>`,
    });
  } catch (err) {
    console.error('[mail] password reset email failed', err);
    void logFailure('email.failed', 'Password reset email failed', err, { data: { kind: 'password_reset' } });
    throw new AppError("We couldn't send the email right now. Try again in a few minutes.", 502, 'EMAIL_FAILED');
  }
  return true;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Invite links live for days; "forgot password" links for minutes. Tells the two apart from the stored row.
export const isInviteToken = (t: { createdAt: Date; expiresAt: Date }) => t.expiresAt.getTime() - t.createdAt.getTime() > TOKEN_TTL_MS;

// An admin added someone who had no account: email them a link to choose their password (same single-use
// link as "Forgot password", valid for 7 days). Returns false if the email couldn't be sent.
export async function sendInvite(user: { id: string; name: string; email: string }, workspaceName: string, inviter: string) {
  const token = randomBytes(32).toString('base64url');
  await prisma.$transaction([
    prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
    prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hash(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
    }),
  ]);
  const appUrl = (process.env.APP_URL || env.webOrigin).replace(/\/$/, '');
  const link = `${appUrl}/reset-password?token=${token}`;
  try {
    await sendMail({
      to: user.email,
      subject: `You've been invited to ${workspaceName} on ${env.appName}`,
      text: `Hi ${user.name},\n\n${inviter} added you to ${workspaceName}. Choose your password to sign in (link valid for 7 days):\n${link}`,
      html: `<p>Hi ${escapeHtml(user.name)},</p><p>${escapeHtml(inviter)} added you to ${escapeHtml(workspaceName)}. Choose your password to sign in (link valid for 7 days):</p><p><a href="${link}">Choose password</a></p>`,
    });
    return true;
  } catch (err) {
    console.error('[mail] invite email failed', err);
    void logFailure('email.failed', 'Invite email failed', err, { data: { kind: 'invite' } });
    return false;
  }
}

// "Your account is ready": sent when an admin creates an account with a password (or adds an existing account to
// a workspace). Carries the login link; the password only when the admin set one just now (they're asked to change
// it after the first sign-in). Returns false if the email couldn't be sent.
export async function sendAccountReady(
  user: { name: string; email: string },
  workspaceName: string,
  inviter: string,
  password: string | null,
) {
  const appUrl = (process.env.APP_URL || env.webOrigin).replace(/\/$/, '');
  const link = `${appUrl}/login`;
  const credentials = password
    ? `\n\nSign in with:\n  Email: ${user.email}\n  Temporary password: ${password}\n\nPlease change it after your first sign-in (My account → Change password).`
    : `\n\nSign in with your usual email and password:\n  Email: ${user.email}`;
  const credentialsHtml = password
    ? `<p>Sign in with:<br>Email: <b>${escapeHtml(user.email)}</b><br>Temporary password: <b>${escapeHtml(password)}</b></p><p>Please change it after your first sign-in (My account → Change password).</p>`
    : `<p>Sign in with your usual email and password:<br>Email: <b>${escapeHtml(user.email)}</b></p>`;
  try {
    await sendMail({
      to: user.email,
      subject: `Your ${workspaceName} account on ${env.appName} is ready`,
      text: `Hi ${user.name},\n\n${inviter} added you to ${workspaceName}. Sign in here:\n${link}${credentials}`,
      html: `<p>Hi ${escapeHtml(user.name)},</p><p>${escapeHtml(inviter)} added you to ${escapeHtml(workspaceName)}.</p><p><a href="${link}">Sign in to ${escapeHtml(env.appName)}</a></p>${credentialsHtml}`,
    });
    return true;
  } catch (err) {
    console.error('[mail] account email failed', err);
    void logFailure('email.failed', 'Account email failed', err, { data: { kind: 'account' } });
    return false;
  }
}

// Sets the new password, uses up the link, and signs out every existing session
export async function resetPassword(rawInput: unknown) {
  const { token, password } = parse(resetSchema, rawInput);
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hash(token) } });
  if (!record || record.usedAt || record.expiresAt.getTime() < Date.now())
    throw new AppError('This reset link is invalid or has expired. Request a new one.', 400, 'INVALID_RESET_TOKEN');

  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.$transaction(async (tx) => {
    // Conditional so the same link can't be used twice at once
    const { count } = await tx.passwordResetToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (count === 0) throw new AppError('This reset link has already been used.', 400, 'INVALID_RESET_TOKEN');
    await tx.user.update({ where: { id: record.userId }, data: { passwordHash, passwordChangedAt: new Date(), updatedBy: record.userId } });
    await tx.passwordResetToken.deleteMany({ where: { userId: record.userId, id: { not: record.id } } });
  });
  await disconnectUser(record.userId); // open tabs stop receiving live updates right away
  return true;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
