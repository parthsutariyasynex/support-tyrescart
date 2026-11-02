import { z } from 'zod';
import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { AppError, notFound } from './errors.js';
import { requireSupervisor } from './permissions.js';
import { parse } from './validate.js';

// Quick replies for the "/" menu in the message box: this workspace's enabled replies, optionally filtered by
// a case-insensitive partial match on shortcut, text or category (the columns use a case-insensitive collation).
const searchSchema = z.object({
  search: z.string().max(100, 'Search is too long').optional(),
  first: z.number().int().min(1).max(100).default(50),
});

const replySelect = {
  id: true,
  shortcut: true,
  description: true,
  category: true,
  sortOrder: true,
  createdAt: true,
  createdBy: true,
  updatedAt: true,
  updatedBy: true,
} as const;

export async function listQuickReplies(workspaceId: string, rawInput: unknown) {
  const { search, first } = parse(searchSchema, rawInput);
  const term = (search ?? '').trim();
  // Prisma's `contains` becomes LIKE '%...%' on MySQL without escaping, so % and _ would act as wildcards
  const escape = (v: string) => v.replace(/[\\%_]/g, '\\$&');
  const like = escape(term);
  // Categories are stored like "car_tyres" but shown as "car tyres": typing either finds them
  const categoryLike = escape(term.replace(/\s+/g, '_'));
  const rows = await prisma.quickReply.findMany({
    where: {
      workspaceId,
      status: 1,
      deletedAt: null,
      ...(term
        ? {
            OR: [
              { shortcut: { contains: like } },
              { description: { contains: like } },
              { category: { contains: like } },
              { category: { contains: categoryLike } },
            ],
          }
        : {}),
    },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: replySelect,
    take: 500,
  });
  if (!term) return rows.slice(0, first);
  // Best matches first: the exact shortcut, then shortcuts starting with / containing the text, then text or category
  const t = term.toLowerCase();
  const rank = (r: (typeof rows)[number]) => {
    const s = r.shortcut.toLowerCase();
    return s === t ? 0 : s.startsWith(t) ? 1 : s.includes(t) ? 2 : 3;
  };
  return rows
    .map((r, i) => ({ r, i, k: rank(r) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .slice(0, first)
    .map(({ r }) => r);
}

// --- Create / edit / delete (Settings → Saved replies): owners, admins and supervisors ---

// Typed after "/" in the message box, so a leading "/" is dropped and spaces aren't allowed
const shortcutSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/^\/+/, ''))
  .pipe(
    z
      .string()
      .min(1, 'Shortcut is required')
      .max(50, 'Shortcut is too long (50 characters at most)')
      .regex(/^[A-Za-z0-9_-]+$/, 'Shortcut can only use letters, numbers, _ and - (no spaces)'),
  );
const descriptionSchema = z.string().trim().min(1, 'Message text is required').max(4096, 'Message text is too long (4096 characters at most)');
// Stored like the imported ones ("car_tyres"); empty clears it
const categorySchema = z
  .string()
  .trim()
  .max(50, 'Category is too long (50 characters at most)')
  .transform((v) => (v ? v.toLowerCase().replace(/\s+/g, '_') : null));
const sortOrderSchema = z.number().int().min(0).max(100000);

const createSchema = z.object({
  shortcut: shortcutSchema,
  description: descriptionSchema,
  category: categorySchema.nullish(),
  sortOrder: sortOrderSchema.optional(),
});
const updateSchema = z.object({
  shortcut: shortcutSchema.optional(),
  description: descriptionSchema.optional(),
  category: categorySchema.nullish(),
  sortOrder: sortOrderSchema.optional(),
});

// No unique index (imported data may hold duplicates), so live shortcuts are checked here (case-insensitive collation)
async function assertShortcutFree(workspaceId: string, shortcut: string, exceptId?: number) {
  const clash = await prisma.quickReply.findFirst({
    where: { workspaceId, shortcut, deletedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) throw new AppError(`A saved reply with the shortcut /${shortcut} already exists`, 409, 'QUICK_REPLY_EXISTS');
}

async function requireQuickReply(workspaceId: string, rawId: string | number) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw notFound('Saved reply');
  const reply = await prisma.quickReply.findFirst({ where: { id, workspaceId, deletedAt: null }, select: { id: true } });
  if (!reply) throw notFound('Saved reply');
  return id;
}

export async function createQuickReply(auth: AuthPayload, rawInput: unknown) {
  await requireSupervisor(auth, 'add a saved reply');
  const { workspaceId, userId } = auth;
  const { shortcut, description, category, sortOrder } = parse(createSchema, rawInput);
  await assertShortcutFree(workspaceId, shortcut);
  // No order given: last in the list
  const order =
    sortOrder ??
    ((await prisma.quickReply.aggregate({ where: { workspaceId, deletedAt: null }, _max: { sortOrder: true } }))._max.sortOrder ?? -1) + 1;
  return prisma.quickReply.create({
    data: { workspaceId, shortcut, description, category: category ?? null, sortOrder: order, createdBy: userId, updatedBy: userId },
    select: replySelect,
  });
}

export async function updateQuickReply(auth: AuthPayload, id: string | number, rawInput: unknown) {
  await requireSupervisor(auth, 'edit a saved reply');
  const { workspaceId, userId } = auth;
  const replyId = await requireQuickReply(workspaceId, id);
  const data = parse(updateSchema, rawInput);
  if (data.shortcut !== undefined) await assertShortcutFree(workspaceId, data.shortcut, replyId);
  return prisma.quickReply.update({
    where: { id: replyId },
    data: {
      ...(data.shortcut !== undefined ? { shortcut: data.shortcut } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.category !== undefined ? { category: data.category } : {}),
      ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
      updatedBy: userId,
    },
    select: replySelect,
  });
}

// Soft delete: the row stays (deletedAt/deletedBy) and drops out of the list and the "/" menu
export async function deleteQuickReply(auth: AuthPayload, id: string | number) {
  await requireSupervisor(auth, 'delete a saved reply');
  const { workspaceId, userId } = auth;
  const replyId = await requireQuickReply(workspaceId, id);
  await prisma.quickReply.update({ where: { id: replyId }, data: { deletedAt: new Date(), deletedBy: userId, updatedBy: userId } });
  return String(replyId);
}
