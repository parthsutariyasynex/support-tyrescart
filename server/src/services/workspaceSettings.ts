import { z } from 'zod';
import type { AuthPayload } from '../auth.js';
import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { APP_TIME_ZONE } from '../time.js';
import { getPermissions, requireAdmin } from './permissions.js';
import { parse } from './validate.js';
import { logFailure } from './logging.js';

// Settings → Company settings → Workspace preferences (admins). Each value is null until an admin sets it, and then
// the app's previous default applies (listed in DEFAULTS), so nothing changes for a workspace that never visits the
// page. Read by: the web app (time zone, phone country, business day start for snooze), assignment reminders,
// presence (away), the deleted-contacts purge, and pinning (pinLimit: the most pinned chats, and pinned messages per chat).
export const DEFAULTS = {
  defaultTimeZone: APP_TIME_ZONE,
  defaultCountry: 'AE',
  businessDayStartHour: 9,
  reminderMinutes: () => env.assignmentReminderMinutes,
  awayMinutes: () => env.presenceAwayMinutes,
  deletedContactRetentionDays: 14,
  pinLimit: 5,
};
export type WorkspaceSettings = {
  defaultTimeZone: string;
  defaultCountry: string;
  businessDayStartHour: number;
  reminderMinutes: number; // 0 = off
  awayMinutes: number;
  deletedContactRetentionDays: number;
  pinLimit: number;
};

const withDefaults = (row: Partial<Record<keyof WorkspaceSettings, unknown>> | null): WorkspaceSettings => ({
  // Always Dubai: the app shows every time in Dubai time (a time zone saved earlier is kept but not used)
  defaultTimeZone: APP_TIME_ZONE,
  defaultCountry: (row?.defaultCountry as string | null) ?? DEFAULTS.defaultCountry,
  businessDayStartHour: (row?.businessDayStartHour as number | null) ?? DEFAULTS.businessDayStartHour,
  reminderMinutes: (row?.reminderMinutes as number | null) ?? DEFAULTS.reminderMinutes(),
  awayMinutes: (row?.awayMinutes as number | null) ?? DEFAULTS.awayMinutes(),
  deletedContactRetentionDays: (row?.deletedContactRetentionDays as number | null) ?? DEFAULTS.deletedContactRetentionDays,
  pinLimit: (row?.pinLimit as number | null) ?? DEFAULTS.pinLimit,
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
  if (!hit || Date.now() - hit.at >= CACHE_MS)
    settingsOf(workspaceId).catch((err) => logFailure('settings.refresh_failed', "Couldn't refresh the workspace settings (the last ones are used)", err, { level: 'WARNING', workspaceId }));
  return hit?.value ?? withDefaults(null);
}

// Replaced (the pin limit is for owners/admins only):
// export async function getWorkspaceSettings(auth: AuthPayload) {
//   await getPermissions(auth); // members only
//   return settingsOf(auth.workspaceId);
// }
// Members read the workspace's defaults (time zone, country…); the pin limit only owners/admins (null for others)
export async function getWorkspaceSettings(auth: AuthPayload) {
  const { isAdmin } = await getPermissions(auth); // members only
  const value = await settingsOf(auth.workspaceId);
  return isAdmin ? value : { ...value, pinLimit: null };
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
  defaultTimeZone: z
    .string()
    .trim()
    .max(64)
    .refine(isTimeZone, 'Choose a time zone from the list')
    .refine((tz) => tz === APP_TIME_ZONE, `All dates and times are shown in Dubai time (${APP_TIME_ZONE})`)
    .optional(),
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
  // Lowering it never unpins anything: new pins wait until the count is under the limit again
  pinLimit: z.number().int().min(1, 'At least 1').max(50, 'Up to 50').optional(),
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
  // Replaced (the pin limit isn't sent to everyone): emitToWorkspace(auth.workspaceId, 'workspace:settings', value);
  const { pinLimit: _adminOnly, ...shared } = value;
  emitToWorkspace(auth.workspaceId, 'workspace:settings', shared); // open apps pick up the new defaults
  return value; // the admin who saved it
}
