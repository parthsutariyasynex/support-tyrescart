import { z } from 'zod';
import { prisma } from '../prisma.js';
import { parse } from './validate.js';

// Quick replies for the "/" menu in the message box: this workspace's enabled replies, optionally filtered by
// a case-insensitive partial match on shortcut, text or category (the columns use a case-insensitive collation).
const searchSchema = z.object({
  search: z.string().max(100, 'Search is too long').optional(),
  first: z.number().int().min(1).max(100).default(50),
});

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
    select: { id: true, shortcut: true, description: true, category: true, sortOrder: true },
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
