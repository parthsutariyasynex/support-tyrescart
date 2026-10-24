// Daily log files (services/logFile.ts): one readable line per entry in logs/app-YYYY-MM-DD.log, a new file each
// day, nothing that breaks when the folder can't be written, and retention of old files (dry run unless deleting).
// Uses a temporary folder, never the real logs/. No server needed: `npx tsx --test test/logFile.test.ts`
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { flushLogFile, formatLine, localDay, localStamp, logFileDir, setLogFileDir, writeLogLine } from '../src/services/logFile.js';
import { type LogRecord, logEvent, runWithRequest, setLogWriter } from '../src/services/logging.js';
import { describeFiles, pruneLogFiles } from '../src/services/logRetention.js';

let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'support-logs-'));
  setLogFileDir(dir);
  setLogWriter(async () => {}); // no database in these tests
});
after(async () => {
  setLogFileDir();
  setLogWriter();
  await rm(dir, { recursive: true, force: true });
});

const record = (over: Partial<LogRecord> = {}): LogRecord => ({
  level: 'ERROR',
  category: 'message',
  event: 'message.status',
  message: "WhatsApp didn't deliver a message",
  requestId: 'req-1234abcd',
  workspaceId: 'w1',
  userId: null,
  errorCode: '131049',
  durationMs: null,
  data: { messageId: 'm1' },
  ...over,
});

describe('one line per entry', () => {
  test('time with its offset, level, event, message, then only the ids and data that are set', () => {
    const at = new Date(2026, 9, 24, 18, 31, 40, 183); // local time
    assert.match(localStamp(at), /^2026-10-24 18:31:40\.183 [+-]\d{2}:\d{2}$/);
    assert.equal(
      formatLine(record(), at),
      `${localStamp(at)} ERROR   message.status WhatsApp didn't deliver a message | req=req-1234abcd workspace=w1 code=131049 data={"messageId":"m1"}`,
    );
    assert.equal(formatLine(record({ level: 'SUCCESS', event: 'x', message: 'ok', requestId: null, workspaceId: null, errorCode: null, data: null, durationMs: 12 }), at), `${localStamp(at)} SUCCESS x ok | 12ms`);
    assert.doesNotMatch(formatLine(record({ message: 'line one\nline two' }), at), /\n/);
  });
});

describe('writing', () => {
  test("logEvent appends the sanitized entry to today's file, with the request id", async () => {
    await runWithRequest('req-file-0001', () =>
      logEvent({ level: 'WARNING', category: 'auth', event: 'login.failed', message: 'Sign-in refused: wrong password', errorCode: 'INVALID_CREDENTIALS', data: { email: 'a@example.com', password: 'hunter2' } }),
    );
    await logEvent({ level: 'SUCCESS', category: 'http', event: 'http.request', message: 'POST /inbox → 200' });
    await flushLogFile();
    const file = path.join(dir, `app-${localDay()}.log`);
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], / WARNING login\.failed Sign-in refused: wrong password \| req=req-file-0001 code=INVALID_CREDENTIALS data=\{"email":"a@example.com","password":"\[REDACTED\]"\}$/);
    assert.doesNotMatch(lines[0], /hunter2/);
    assert.match(lines[1], / SUCCESS http\.request POST \/inbox → 200$/);
  });
  test('a new day starts a new file; earlier lines stay where they were', async () => {
    writeLogLine(record({ message: 'day one' }), new Date(2026, 0, 1, 23, 59));
    writeLogLine(record({ message: 'day two' }), new Date(2026, 0, 2, 0, 1));
    await flushLogFile();
    await new Promise((r) => setTimeout(r, 50)); // the previous day's file finishes closing
    assert.match(await readFile(path.join(dir, 'app-2026-01-01.log'), 'utf8'), /day one/);
    assert.match(await readFile(path.join(dir, 'app-2026-01-02.log'), 'utf8'), /day two/);
    assert.doesNotMatch(await readFile(path.join(dir, 'app-2026-01-02.log'), 'utf8'), /day one/);
  });
  test("a folder that can't be written: no error for the caller, the terminal says why once", async () => {
    const blocker = path.join(dir, 'not-a-folder');
    await writeFile(blocker, 'x');
    setLogFileDir(path.join(blocker, 'logs')); // a folder inside a file: mkdir fails
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(' '));
    try {
      assert.doesNotThrow(() => writeLogLine(record()));
      assert.doesNotThrow(() => writeLogLine(record()));
      await assert.doesNotReject(logEvent({ level: 'ERROR', category: 'http', event: 'x', message: 'still fine' }));
    } finally {
      console.warn = warn;
      setLogFileDir(dir);
    }
    assert.equal(warnings.filter((w) => w.includes("Couldn't write the log file")).length, 1);
  });
  test('LOG_TO_FILE=false (no folder): nothing is written', async () => {
    setLogFileDir(null);
    assert.equal(logFileDir(), null);
    const before = await readdir(dir);
    writeLogLine(record());
    await flushLogFile();
    assert.deepEqual(await readdir(dir), before);
    setLogFileDir(dir);
  });
});

describe('retention of old files', () => {
  test('dry run lists files older than the cutoff with their size; delete removes only those', async () => {
    const files = path.join(dir, 'retention');
    await rm(files, { recursive: true, force: true });
    await (await import('node:fs/promises')).mkdir(files);
    const now = new Date(2026, 9, 24, 12, 0); // cutoff with 30 days: 2026-09-24
    for (const name of ['app-2026-08-01.log', 'app-2026-09-23.log', 'app-2026-09-24.log', 'app-2026-10-24.log', 'notes.txt', 'app-latest.log'])
      await writeFile(path.join(files, name), 'x'.repeat(100));

    const dry = await pruneLogFiles({ days: 30, now, dir: files });
    assert.equal(dry.cutoffDay, '2026-09-24');
    assert.deepEqual(dry.files, ['app-2026-08-01.log', 'app-2026-09-23.log']);
    assert.deepEqual([dry.bytes, dry.deleted, dry.dryRun], [200, 0, true]);
    assert.equal((await readdir(files)).length, 6, 'nothing deleted');
    assert.match(describeFiles(dry), /^Dry run: 2 log files are from before 2026-09-24 .*nothing deleted$/);

    const done = await pruneLogFiles({ days: 30, now, dir: files, dryRun: false });
    assert.equal(done.deleted, 2);
    assert.deepEqual((await readdir(files)).sort(), ['app-2026-09-24.log', 'app-2026-10-24.log', 'app-latest.log', 'notes.txt']);
  });
  test('a missing folder has no files; bad days are refused', async () => {
    assert.deepEqual((await pruneLogFiles({ days: 30, dir: path.join(dir, 'missing') })).files, []);
    await assert.rejects(pruneLogFiles({ days: 0, dir }), /whole number of days/);
  });
});
