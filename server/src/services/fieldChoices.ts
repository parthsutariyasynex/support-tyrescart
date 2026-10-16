import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { AppError } from './errors.js';
import { requireAdmin } from './permissions.js';
import { parse } from './validate.js';

// The choices of the Lead source and Priority properties, per workspace (Settings → Contact properties → edit).
// Contacts store a choice's `value`, which never changes, so renaming keeps every contact on it. The first time a
// workspace needs them they are created from the standard lists below (the ones the app had before), so existing
// contacts keep their values.
export const CHOICE_FIELDS = ['leadSource', 'priority'] as const;
export type ChoiceField = (typeof CHOICE_FIELDS)[number];
const STANDARD: Record<ChoiceField, { value: string; label: string }[]> = {
  leadSource: [
    { value: 'whatsapp', label: 'WhatsApp' },
    { value: 'website', label: 'Website' },
    { value: 'referral', label: 'Referral' },
    { value: 'walk_in', label: 'Walk-in' },
    { value: 'phone_call', label: 'Phone call' },
    { value: 'social_media', label: 'Social media' },
    { value: 'other', label: 'Other' },
  ],
  priority: [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'urgent', label: 'Urgent' },
  ],
};
export const MAX_CHOICES = 50;

export async function choicesOf(workspaceId: string, field: ChoiceField) {
  const find = () =>
    prisma.contactFieldChoice.findMany({ where: { workspaceId, field }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], select: { value: true, label: true } });
  let rows = await find();
  if (!rows.length) {
    await prisma.contactFieldChoice.createMany({ data: STANDARD[field].map((c, i) => ({ ...c, workspaceId, field, position: i })), skipDuplicates: true });
    rows = await find();
  }
  return rows;
}

export async function requireChoice(workspaceId: string, field: ChoiceField, value: string, label: string) {
  if (!(await choicesOf(workspaceId, field)).some((c) => c.value === value)) throw new AppError(`Choose a valid ${label}`, 400, 'BAD_USER_INPUT');
}

// The full list, in order: existing choices keep their value (and so their contacts); new ones get one; a removed
// choice is cleared from the contacts that had it (the admin is told how many first)
const saveSchema = z.object({
  field: z.enum(CHOICE_FIELDS, { message: 'Unknown property' }),
  choices: z
    .array(z.object({ value: z.string().max(20).optional().nullable(), label: z.string().trim().min(1, 'Choices need a name').max(60, 'Choices can be up to 60 characters') }))
    .min(1, 'Keep at least one choice')
    .max(MAX_CHOICES, `Up to ${MAX_CHOICES} choices`),
});

export async function saveFieldChoices(auth: AuthPayload, rawInput: unknown) {
  await requireAdmin(auth);
  const { field, choices } = parse(saveSchema, rawInput ?? {});
  const labels = choices.map((c) => c.label.toLowerCase());
  if (new Set(labels).size !== labels.length) throw new AppError('Two choices have the same name', 400, 'BAD_USER_INPUT');
  const current = await choicesOf(auth.workspaceId, field);
  const known = new Set(current.map((c) => c.value));
  // New values are 9 characters (c + 8 hex), which fits Contact.priority (VarChar(10))
  const next = choices.map((c) => ({ value: c.value && known.has(c.value) ? c.value : `c${randomBytes(4).toString('hex')}`, label: c.label }));
  const removed = current.filter((c) => !next.some((n) => n.value === c.value)).map((c) => c.value);
  const cleared = await prisma.$transaction(async (tx) => {
    const r = removed.length
      ? await tx.contact.updateMany({ where: { workspaceId: auth.workspaceId, [field]: { in: removed } }, data: { [field]: null, updatedBy: auth.userId } })
      : { count: 0 };
    await tx.contactFieldChoice.deleteMany({ where: { workspaceId: auth.workspaceId, field } });
    await tx.contactFieldChoice.createMany({ data: next.map((c, i) => ({ ...c, workspaceId: auth.workspaceId, field, position: i, createdBy: auth.userId })) });
    return r.count;
  });
  emitToWorkspace(auth.workspaceId, 'leadStages:changed', {}); // the same "field options changed" signal the app follows
  return { choices: await choicesOf(auth.workspaceId, field), cleared };
}

// Contacts per choice (shown before removing one)
export async function choiceCounts(auth: AuthPayload, field: ChoiceField) {
  await requireAdmin(auth);
  const rows = await prisma.contact.groupBy({ by: [field], where: { workspaceId: auth.workspaceId, deletedAt: null }, _count: { _all: true } });
  return rows.map((r) => ({ value: (r as Record<string, unknown>)[field] as string | null, count: r._count._all }));
}
