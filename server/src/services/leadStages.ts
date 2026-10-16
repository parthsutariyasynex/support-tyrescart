import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { AppError, notFound } from './errors.js';
import { getPermissions, requireAdmin } from './permissions.js';
import { parse } from './validate.js';

// Settings → Customer lifecycle: each workspace's lead stages, edited by admins. Contacts keep the stage's `value`,
// so renaming, recolouring or reordering never touches them. The first time a workspace needs its stages they are
// created from the standard set below (the ones the app had before stages became editable), so every contact
// already on one of them stays on it.
const STANDARD_STAGES = [
  { value: 'new', label: 'New', color: '#eab308', lost: false, isDefault: true },
  { value: 'contacted', label: 'Contacted', color: '#f97316', lost: false, isDefault: false },
  { value: 'qualified', label: 'Qualified', color: '#3b82f6', lost: false, isDefault: false },
  { value: 'proposal', label: 'Proposal sent', color: '#14b8a6', lost: false, isDefault: false },
  { value: 'won', label: 'Won', color: '#16a34a', lost: false, isDefault: false },
  { value: 'lost', label: 'Lost', color: '#dc2626', lost: true, isDefault: false },
];
export const MAX_STAGES = 20;

type Stage = { id: string; value: string; label: string; color: string; lost: boolean; position: number; isDefault: boolean };
// As the app shows them: progressing stages in order, then the lost ones (`closed` = lost)
const toOption = (s: Stage) => ({ id: s.id, value: s.value, label: s.label, color: s.color, closed: s.lost, isDefault: s.isDefault });
const sorted = (rows: Stage[]) => [...rows.filter((s) => !s.lost), ...rows.filter((s) => s.lost)];

async function stagesOf(workspaceId: string): Promise<Stage[]> {
  const find = () => prisma.leadStage.findMany({ where: { workspaceId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
  let rows = await find();
  if (!rows.length) {
    await prisma.leadStage.createMany({ data: STANDARD_STAGES.map((s, i) => ({ ...s, workspaceId, position: i })), skipDuplicates: true });
    rows = await find();
  }
  return sorted(rows);
}

export async function listLeadStages(workspaceId: string) {
  return (await stagesOf(workspaceId)).map(toOption);
}
// The stage new contacts start on (null if somehow none)
export async function defaultStageValue(workspaceId: string) {
  return (await stagesOf(workspaceId)).find((s) => s.isDefault)?.value ?? null;
}
// Is `value` one of this workspace's stages?
export async function requireStageValue(workspaceId: string, value: string) {
  const stage = (await stagesOf(workspaceId)).find((s) => s.value === value);
  if (!stage) throw new AppError('Choose a valid lead stage', 400, 'BAD_USER_INPUT');
  return stage;
}

// Everyone's stage menus and pills follow; `moved` = contacts that changed stage because one was deleted
const announce = (workspaceId: string, moved?: { from: string; to: string | null }) => emitToWorkspace(workspaceId, 'leadStages:changed', moved ? { moved } : {});
const labelSchema = z.string().trim().min(1, 'Enter a stage name').max(40, 'Stage names can be up to 40 characters');
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Choose a colour').transform((c) => c.toLowerCase());

async function requireStage(workspaceId: string, id: string) {
  const stages = await stagesOf(workspaceId);
  const stage = stages.find((s) => s.id === id);
  if (!stage) throw notFound('Stage');
  return { stage, stages };
}
const sameName = (stages: Stage[], label: string, except?: string) => stages.some((s) => s.id !== except && s.label.toLowerCase() === label.toLowerCase());

export async function createLeadStage(auth: AuthPayload, rawInput: unknown) {
  await requireAdmin(auth);
  const input = parse(z.object({ label: labelSchema, color: colorSchema, lost: z.boolean().default(false) }), rawInput ?? {});
  const stages = await stagesOf(auth.workspaceId);
  if (stages.length >= MAX_STAGES) throw new AppError(`You can create up to ${MAX_STAGES} lifecycle stages in total`, 400, 'BAD_USER_INPUT');
  if (sameName(stages, input.label)) throw new AppError(`There is already a stage called “${input.label}”`, 409, 'CONFLICT');
  const position = Math.max(-1, ...stages.filter((s) => s.lost === input.lost).map((s) => s.position)) + 1;
  await prisma.leadStage.create({
    data: { workspaceId: auth.workspaceId, value: `s${randomBytes(6).toString('hex')}`, label: input.label, color: input.color, lost: input.lost, position, createdBy: auth.userId, updatedBy: auth.userId },
  });
  announce(auth.workspaceId);
  return listLeadStages(auth.workspaceId);
}

// Rename or recolour (contacts on it keep it)
export async function updateLeadStage(auth: AuthPayload, id: string, rawInput: unknown) {
  await requireAdmin(auth);
  const input = parse(z.object({ label: labelSchema.optional(), color: colorSchema.optional() }), rawInput ?? {});
  const { stages } = await requireStage(auth.workspaceId, id);
  if (input.label && sameName(stages, input.label, id)) throw new AppError(`There is already a stage called “${input.label}”`, 409, 'CONFLICT');
  await prisma.leadStage.update({ where: { id }, data: { ...input, updatedBy: auth.userId } });
  announce(auth.workspaceId);
  return listLeadStages(auth.workspaceId);
}

// The full order of both groups (a stage moves between Progressing and Lost by being listed in the other one)
export async function reorderLeadStages(auth: AuthPayload, rawInput: unknown) {
  await requireAdmin(auth);
  const input = parse(z.object({ progressing: z.array(z.string()).max(MAX_STAGES), lost: z.array(z.string()).max(MAX_STAGES) }), rawInput ?? {});
  const stages = await stagesOf(auth.workspaceId);
  const ids = [...input.progressing, ...input.lost];
  if (ids.length !== stages.length || new Set(ids).size !== ids.length || !stages.every((s) => ids.includes(s.id)))
    throw new AppError('The stages changed meanwhile; reload and try again', 409, 'CONFLICT');
  if (!input.progressing.length) throw new AppError('Keep at least one progressing stage', 400, 'BAD_USER_INPUT');
  const def = stages.find((s) => s.isDefault);
  if (def && input.lost.includes(def.id)) throw new AppError('The default stage must be a progressing stage', 400, 'BAD_USER_INPUT');
  await prisma.$transaction([
    ...input.progressing.map((sid, i) => prisma.leadStage.update({ where: { id: sid }, data: { lost: false, position: i, updatedBy: auth.userId } })),
    ...input.lost.map((sid, i) => prisma.leadStage.update({ where: { id: sid }, data: { lost: true, position: i, updatedBy: auth.userId } })),
  ]);
  announce(auth.workspaceId);
  return listLeadStages(auth.workspaceId);
}

// The stage new contacts start on (a progressing one)
export async function setDefaultLeadStage(auth: AuthPayload, id: string) {
  await requireAdmin(auth);
  const { stage } = await requireStage(auth.workspaceId, id);
  if (stage.lost) throw new AppError('The default stage must be a progressing stage', 400, 'BAD_USER_INPUT');
  await prisma.$transaction([
    prisma.leadStage.updateMany({ where: { workspaceId: auth.workspaceId, isDefault: true }, data: { isDefault: false, updatedBy: auth.userId } }),
    prisma.leadStage.update({ where: { id }, data: { isDefault: true, updatedBy: auth.userId } }),
  ]);
  announce(auth.workspaceId);
  return listLeadStages(auth.workspaceId);
}

// Contacts on the stage move to `moveTo` (another stage's value) or to no stage (null); the admin chooses first
export async function deleteLeadStage(auth: AuthPayload, id: string, moveTo: string | null) {
  await requireAdmin(auth);
  const { stage, stages } = await requireStage(auth.workspaceId, id);
  if (stage.isDefault) throw new AppError('Choose another default stage before deleting this one', 400, 'BAD_USER_INPUT');
  if (!stage.lost && stages.filter((s) => !s.lost).length <= 1) throw new AppError('Keep at least one progressing stage', 400, 'BAD_USER_INPUT');
  if (moveTo && (moveTo === stage.value || !stages.some((s) => s.value === moveTo))) throw new AppError('Choose another stage to move its contacts to', 400, 'BAD_USER_INPUT');
  const moved = await prisma.$transaction(async (tx) => {
    const r = await tx.contact.updateMany({ where: { workspaceId: auth.workspaceId, leadStage: stage.value }, data: { leadStage: moveTo, updatedBy: auth.userId } });
    await tx.leadStage.delete({ where: { id } });
    return r.count;
  });
  announce(auth.workspaceId, { from: stage.value, to: moveTo });
  return { stages: await listLeadStages(auth.workspaceId), moved };
}

export async function getLeadStages(auth: AuthPayload) {
  await getPermissions(auth);
  return listLeadStages(auth.workspaceId);
}
