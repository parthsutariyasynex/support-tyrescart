import { z } from 'zod';
import type { AuthPayload } from '../auth.js';
import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { getPermissions, requireAdmin } from './permissions.js';
import { parse } from './validate.js';

// Settings → Company settings → Workspace preferences (admins). Each value is null until an admin sets it, and then
// the app's previous default applies (listed in DEFAULTS), so nothing changes for a workspace that never visits the
// page. Read by: the web app (time zone, phone country, business day start for snooze), assignment reminders,
// presence (away), and the deleted-contacts purge.
export const DEFAULTS = {
  defaultTimeZone: 'Asia/Dubai',
  defaultCountry: 'AE',
  businessDayStartHour: 9,
  reminderMinutes: () => env.assignmentReminderMinutes,
  awayMinutes: () => env.presenceAwayMinutes,
  deletedContactRetentionDays: 14,
};
export type WorkspaceSettings = {
  defaultTimeZone: string;
  defaultCountry: string;
  businessDayStartHour: number;
  reminderMinutes: number; // 0 = off
  awayMinutes: number;
  deletedContactRetentionDays: number;
};

const withDefaults = (row: Partial<Record<keyof WorkspaceSettings, unknown>> | null): WorkspaceSettings => ({
  defaultTimeZone: (row?.defaultTimeZone as string | null) ?? DEFAULTS.defaultTimeZone,
  defaultCountry: (row?.defaultCountry as string | null) ?? DEFAULTS.defaultCountry,
  businessDayStartHour: (row?.businessDayStartHour as number | null) ?? DEFAULTS.businessDayStartHour,
  reminderMinutes: (row?.reminderMinutes as number | null) ?? DEFAULTS.reminderMinutes(),
  awayMinutes: (row?.awayMinutes as number | null) ?? DEFAULTS.awayMinutes(),
  deletedContactRetentionDays: (row?.deletedContactRetentionDays as number | null) ?? DEFAULTS.deletedContactRetentionDays,
});

// Kept in memory for the background jobs (presence sweeps run every few seconds); refreshed on save
const cache = new Map<string, { at: number; value: WorkspaceSettings }>();
const CACHE_MS = 60_000;

export async function settingsOf(workspaceId: string): Promise<WorkspaceSettings> {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const row = await prisma.workspaceSettings.findUnique({ where: { workspaceId } });
  const value = withDefaults(row);
  cache.set(workspaceId, { at: Date.now(), value });
  return value;
}
// For synchronous callers: the last known settings (or the defaults), refreshing in the background
export function cachedSettingsOf(workspaceId: string): WorkspaceSettings {
  const hit = cache.get(workspaceId);
  if (!hit || Date.now() - hit.at >= CACHE_MS) settingsOf(workspaceId).catch(() => {});
  return hit?.value ?? withDefaults(null);
}

export async function getWorkspaceSettings(auth: AuthPayload) {
  await getPermissions(auth); // members only
  return settingsOf(auth.workspaceId);
}

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz);
  } catch {
    return false;
  }
};
const updateSchema = z.object({
  defaultTimeZone: z.string().trim().max(64).refine(isTimeZone, 'Choose a time zone from the list').optional(),
  defaultCountry: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, 'Choose a country')
    .transform((c) => c.toUpperCase())
    .optional(),
  businessDayStartHour: z.number().int().min(0, 'Choose an hour').max(23, 'Choose an hour').optional(),
  reminderMinutes: z.number().int().min(0, 'Use 0 (off) or more minutes').max(1440, 'Up to 1440 minutes (a day)').optional(),
  awayMinutes: z.number().int().min(1, 'At least 1 minute').max(240, 'Up to 240 minutes').optional(),
  deletedContactRetentionDays: z.number().int().min(1, 'At least 1 day').max(90, 'Up to 90 days').optional(),
});

export async function updateWorkspaceSettings(auth: AuthPayload, rawInput: unknown) {
  await requireAdmin(auth);
  const input = parse(updateSchema, rawInput ?? {});
  const data = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  await prisma.workspaceSettings.upsert({
    where: { workspaceId: auth.workspaceId },
    update: { ...data, updatedBy: auth.userId },
    create: { workspaceId: auth.workspaceId, ...data, updatedBy: auth.userId },
  });
  cache.delete(auth.workspaceId);
  const value = await settingsOf(auth.workspaceId);
  emitToWorkspace(auth.workspaceId, 'workspace:settings', value); // open apps pick up the new defaults
  return value;
}
