// Log retention (services/logRetention.ts): settings made safe, a dry run that only counts, deleting in batches that
// removes only entries older than the cutoff, the daily job, and the npm script. Needs the local database with the
// LogEntry table. Only its own rows are touched: they are dated in the year 2000, so the cutoffs used here can't
// reach real entries (checked before anything is deleted). `npx tsx --test test/logRetention.test.ts`
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import { prisma } from '../src/prisma.js';
import { type LogRecord, setLogWriter } from '../src/services/logging.js';
import { DEFAULT_RETENTION_DAYS, describeResult, pruneLogs, retentionPolicy, startLogRetention } from '../src/services/logRetention.js';

const TAG = `test-retention-${Date.now()}`;
const now = new Date('2001-01-01T00:00:00Z'); // with days = 30, the cutoff is 2000-12-02
const old = (date: string, level: string) => ({ level, category: 'system', event: 'test.retention', message: 'retention test entry', requestId: TAG, createdAt: new Date(date) });
const DAY_MS = 86_400_000;
// Other test files run at the same time and add entries (and remove their own test-* ones), so "nothing else was
// deleted" is checked on the entries that existed before this file started and belong to no test
const started = new Date();
const settled = () => prisma.logEntry.count({ where: { createdAt: { lt: started }, NOT: { requestId: { startsWith: 'test-' } } } });

before(async () => {
  await prisma.logEntry.createMany({
    data: [
      old('2000-03-01T00:00:00Z', 'SUCCESS'),
      old('2000-06-01T00:00:00Z', 'WARNING'),
      old('2000-09-01T00:00:00Z', 'ERROR'),
      old('2000-11-30T00:00:00Z', 'SUCCESS'),
      old('2000-12-15T00:00:00Z', 'SUCCESS'), // newer than the cutoff: kept
    ],
  });
});
after(async () => {
  setLogWriter();
  await prisma.logEntry.deleteMany({ where: { requestId: TAG } });
  await prisma.$disconnect();
});

describe('retentionPolicy', () => {
  test('defaults to 90 days and a dry run', () => {
    assert.deepEqual(retentionPolicy(undefined, undefined), { days: DEFAULT_RETENTION_DAYS, mode: 'dry-run', problems: [] });
    assert.deepEqual(retentionPolicy('30', 'DELETE'), { days: 30, mode: 'delete', problems: [] });
    assert.deepEqual(retentionPolicy(7, 'off'), { days: 7, mode: 'off', problems: [] });
  });
  test('bad values fall back to the safe default and say why (never more deleting)', () => {
    for (const bad of ['0', '-5', '1.5', 'abc', '', ' ']) {
      const p = retentionPolicy(bad, 'dry-run');
      assert.equal(p.days, DEFAULT_RETENTION_DAYS, `days "${bad}"`);
      assert.equal(p.problems.length, 1);
    }
    const p = retentionPolicy('30', 'delet');
    assert.equal(p.mode, 'dry-run');
    assert.match(p.problems[0], /LOG_RETENTION_MODE/);
  });
});

describe('pruneLogs', () => {
  test('refuses a retention below 1 day or not whole days', async () => {
    for (const days of [0, -1, 1.5, NaN]) await assert.rejects(pruneLogs({ days, dryRun: true }), /whole number of days/);
  });
  test('dry run (the default) counts what is older than the cutoff, by level, and deletes nothing', async () => {
    const total = await settled();
    const ours = await prisma.logEntry.count({ where: { requestId: TAG } });
    const r = await pruneLogs({ days: 30, now });
    assert.equal(r.dryRun, true);
    assert.equal(r.cutoff.toISOString(), new Date(now.getTime() - 30 * DAY_MS).toISOString());
    assert.equal(r.matched, 4);
    assert.deepEqual(r.byLevel, { SUCCESS: 2, WARNING: 1, ERROR: 1 });
    assert.equal(r.deleted, 0);
    assert.equal(await settled(), total, 'nothing deleted');
    assert.equal(await prisma.logEntry.count({ where: { requestId: TAG } }), ours, 'not even the old test entries');
    assert.match(describeResult(r), /^Dry run: 4 log entries are older than 30 days .*nothing deleted$/);
  });
  test('delete mode removes exactly the older entries, in batches, oldest first; newer ones stay', async () => {
    const cutoff = new Date(now.getTime() - 30 * DAY_MS);
    // Safety: only this test's rows may be older than the cutoff
    assert.equal(await prisma.logEntry.count({ where: { createdAt: { lt: cutoff }, NOT: { requestId: TAG } } }), 0, 'no real entries in reach');
    const others = await settled();
    const r = await pruneLogs({ days: 30, now, dryRun: false, batchSize: 3 }); // 4 rows: two batches
    assert.deepEqual([r.matched, r.deleted], [4, 4]);
    const left = await prisma.logEntry.findMany({ where: { requestId: TAG }, select: { createdAt: true } });
    assert.deepEqual(left.map((l) => l.createdAt.toISOString()), ['2000-12-15T00:00:00.000Z']);
    assert.equal(await settled(), others, 'no other entry touched');
    assert.match(describeResult(r), /^Deleted 4 of 4 log entries older than 30 days/);
  });
});

describe('the daily job', () => {
  test('dry run by default: reports the count as a logs.retention entry and deletes nothing', async () => {
    const logs: LogRecord[] = [];
    setLogWriter(async (r) => logs.push(r));
    const quiet = console.log;
    console.log = () => {};
    const total = await settled();
    const stop = startLogRetention(retentionPolicy(36500, undefined), 3_600_000);
    try {
      for (let i = 0; i < 100 && !logs.some((l) => l.event === 'logs.retention'); i++) await new Promise((r) => setTimeout(r, 20));
    } finally {
      stop();
      console.log = quiet;
      setLogWriter();
    }
    const entry = logs.find((l) => l.event === 'logs.retention')!;
    assert.ok(entry, 'the run is logged');
    assert.equal(entry.level, 'SUCCESS');
    assert.equal(entry.category, 'system');
    assert.match(entry.message, /^Dry run: \d+ log entries are older than 36500 days/);
    assert.equal((entry.data as any).mode, 'dry-run');
    assert.equal((entry.data as any).deleted, 0);
    assert.equal(await settled(), total, 'nothing deleted');
  });
  test('off: does nothing at all', async () => {
    const logs: LogRecord[] = [];
    setLogWriter(async (r) => logs.push(r));
    const stop = startLogRetention(retentionPolicy(30, 'off'));
    await new Promise((r) => setTimeout(r, 100));
    stop();
    setLogWriter();
    assert.equal(logs.length, 0);
  });
});

describe('npm run logs:retention', () => {
  const run = (...args: string[]) => promisify(execFile)('npx', ['tsx', 'scripts/logRetention.ts', ...args], { cwd: fileURLToPath(new URL('..', import.meta.url)) });
  test('a dry run unless --delete is given', async () => {
    const { stdout } = await run('--days', '36500');
    assert.match(stdout, /^Dry run: \d+ log entries are older than 36500 days .*nothing deleted$/m);
  });
  test('refuses a bad --days value', async () => {
    await assert.rejects(run('--days', '0'), (err: any) => err.code === 1 && /whole number of days/.test(err.stderr));
  });
});
