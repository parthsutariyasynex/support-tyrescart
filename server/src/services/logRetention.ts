// How long backend logs are kept: LogEntry rows and the daily log files (logs/app-YYYY-MM-DD.log). A daily job looks
// for those older than LOG_RETENTION_DAYS and, by default, only counts them (dry run): nothing is deleted unless
// LOG_RETENTION_MODE=delete. The same check can be run
// by hand with `npm run logs:retention` (dry run; add -- --delete to remove them). Deleting goes in small batches,
// oldest first, so the table is never locked for long.
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { LOG_FILE_PATTERN, localDay, logFileDir } from './logFile.js';
import { logEvent } from './logging.js';

export const DEFAULT_RETENTION_DAYS = 90;
export const RETENTION_MODES = ['dry-run', 'delete', 'off'] as const;
export type RetentionMode = (typeof RETENTION_MODES)[number];
const DAY_MS = 86_400_000;

// The settings as given, made safe: whole days, at least 1 (else the default); an unknown mode is a dry run.
// `problems` says what was replaced, so a typo in .env is reported rather than silently deleting more.
export function retentionPolicy(days: unknown = env.logRetentionDays, mode: unknown = env.logRetentionMode) {
  const problems: string[] = [];
  const n = typeof days === 'string' && days.trim() === '' ? NaN : Number(days);
  const validDays = Number.isInteger(n) && n >= 1;
  if (days !== undefined && !validDays) problems.push(`LOG_RETENTION_DAYS must be a whole number of days (1 or more); using ${DEFAULT_RETENTION_DAYS}`);
  const m = String(mode ?? '').trim().toLowerCase();
  const validMode = (RETENTION_MODES as readonly string[]).includes(m);
  if (mode !== undefined && mode !== '' && !validMode) problems.push(`LOG_RETENTION_MODE must be one of ${RETENTION_MODES.join(', ')}; using dry-run`);
  return { days: validDays ? n : DEFAULT_RETENTION_DAYS, mode: (validMode ? m : 'dry-run') as RetentionMode, problems };
}

export type PruneResult = { cutoff: Date; days: number; dryRun: boolean; matched: number; byLevel: Record<string, number>; deleted: number };

// Entries older than `days` (before now - days): counted, and deleted only when dryRun is false
export async function pruneLogs({ days, dryRun = true, now = new Date(), batchSize = 1000 }: { days: number; dryRun?: boolean; now?: Date; batchSize?: number }): Promise<PruneResult> {
  if (!Number.isInteger(days) || days < 1) throw new Error('Log retention needs a whole number of days, 1 or more');
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const where = { createdAt: { lt: cutoff } };
  const groups = await prisma.logEntry.groupBy({ by: ['level'], where, _count: { _all: true } });
  const byLevel = Object.fromEntries(groups.map((g) => [g.level, g._count._all]));
  const matched = groups.reduce((sum, g) => sum + g._count._all, 0);
  let deleted = 0;
  if (!dryRun && matched) {
    for (;;) {
      const batch = await prisma.logEntry.findMany({ where, select: { id: true }, orderBy: { createdAt: 'asc' }, take: batchSize });
      if (!batch.length) break;
      deleted += (await prisma.logEntry.deleteMany({ where: { id: { in: batch.map((b) => b.id) } } })).count;
      if (batch.length < batchSize) break;
    }
  }
  return { cutoff, days, dryRun, matched, byLevel, deleted };
}

export type FilePruneResult = { cutoffDay: string; dryRun: boolean; files: string[]; bytes: number; deleted: number };

// Daily log files whose whole day is before the cutoff (app-2026-07-25.log when the cutoff falls on 26 July): listed
// with their size, and deleted only when dryRun is false. Today's file is never touched; a missing folder is none.
export async function pruneLogFiles({ days, dryRun = true, now = new Date(), dir = logFileDir() }: { days: number; dryRun?: boolean; now?: Date; dir?: string | null }): Promise<FilePruneResult> {
  if (!Number.isInteger(days) || days < 1) throw new Error('Log retention needs a whole number of days, 1 or more');
  const cutoffDay = localDay(new Date(now.getTime() - days * DAY_MS));
  const result: FilePruneResult = { cutoffDay, dryRun, files: [], bytes: 0, deleted: 0 };
  if (!dir) return result;
  const names = await readdir(dir).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[];
    throw err;
  });
  const today = localDay(now);
  result.files = names.filter((n) => { const day = LOG_FILE_PATTERN.exec(n)?.[1]; return !!day && day < cutoffDay && day !== today; }).sort();
  for (const name of result.files) {
    const full = path.join(dir, name);
    result.bytes += (await stat(full)).size;
    if (!dryRun) {
      await rm(full, { force: true });
      result.deleted++;
    }
  }
  return result;
}

export function describeFiles(r: FilePruneResult) {
  const size = `${(r.bytes / 1024 / 1024).toFixed(1)} MB`;
  return r.dryRun
    ? `Dry run: ${r.files.length} log files are from before ${r.cutoffDay} (${size}); nothing deleted`
    : `Deleted ${r.deleted} log files from before ${r.cutoffDay} (${size})`;
}

export function describeResult(r: PruneResult) {
  const levels = Object.entries(r.byLevel).map(([l, n]) => `${n} ${l}`).join(', ');
  return r.dryRun
    ? `Dry run: ${r.matched} log entries are older than ${r.days} days (before ${r.cutoff.toISOString()})${levels ? ` (${levels})` : ''}; nothing deleted`
    : `Deleted ${r.deleted} of ${r.matched} log entries older than ${r.days} days (before ${r.cutoff.toISOString()})`;
}

// The daily job (started with the server): off, a dry run (default) or deleting, as LOG_RETENTION_MODE says
export function startLogRetention(policy = retentionPolicy(), intervalMs = 24 * 60 * 60_000) {
  for (const p of policy.problems) console.warn(`[logs] ${p}`);
  if (policy.mode === 'off') return () => {};
  const dryRun = policy.mode !== 'delete';
  const run = () =>
    Promise.all([pruneLogs({ days: policy.days, dryRun }), pruneLogFiles({ days: policy.days, dryRun })])
      .then(([r, f]) => {
        console.log(`[logs] ${describeResult(r)}`);
        console.log(`[logs] ${describeFiles(f)}`);
        return logEvent({
          level: 'SUCCESS',
          category: 'system',
          event: 'logs.retention',
          message: `${describeResult(r)}. ${describeFiles(f)}`,
          data: {
            mode: policy.mode,
            days: r.days,
            cutoff: r.cutoff,
            matched: r.matched,
            deleted: r.deleted,
            byLevel: r.byLevel,
            files: { matched: f.files.length, deleted: f.deleted, bytes: f.bytes },
          },
        });
      })
      .catch((err) =>
        logEvent({ level: 'ERROR', category: 'system', event: 'logs.retention', message: `Log retention failed: ${(err as Error)?.message ?? String(err)}`, data: { mode: policy.mode, days: policy.days } }),
      );
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
