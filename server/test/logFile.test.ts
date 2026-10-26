// Daily log files (services/logFile.ts): one JSON line per entry in logs/YYYY-MM-DD.log, a new file each
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
  logId: 42,
  level: 'ERROR',
  category: 'message',
  event: 'message.status',
  message: "WhatsApp didn't deliver a message",
  requestId: 'req-1234abcd',
  workspaceId: 'w1',
  userId: null,
  errorCode: 131049,
  durationMs: null,
  direction: 'out',
  messageId: 'm1',
  waMessageId: 'wamid.ABC',
  waMessageRef: 'wa:0123456789abcdef',
  conversationId: 'c1',
  messageSent: 1,
  customerReceived: 0,
  deliveryStatus: 'failed',
  content: null,
  previousStatus: 'sent',
  newStatus: 'failed',
  action: "Update a sent message's delivery status",
  reason: 'Meta\'s webhook reported the message as "failed" (it was "sent")',
  outcome: 'not delivered',
  source: 'src/messages.ts:262 logStatus',
  request: null,
  response: null,
  errorDetails: 'This message was not delivered to maintain healthy ecosystem engagement.',
  data: { type: 'template' },
  at: new Date(2026, 9, 24, 18, 31, 40, 183),
  ...over,
});

const KEYS = [
  'logId', 'timestamp', 'level', 'outcome', 'category', 'event', 'action', 'reason', 'source', 'direction', 'previousStatus', 'newStatus', 'requestId', 'messageId',
  'waMessageId', 'waMessageRef', 'conversationId', 'messageSent', 'customerReceived', 'deliveryStatus', 'workspaceId', 'userId', 'durationMs', 'errorCode', 'errorDetails',
  'message', 'content', 'request', 'response', 'data',
];

describe('one JSON line per entry', () => {
  test('ISO time with its offset, then every field, always the same keys in the same order', () => {
    const at = new Date(2026, 9, 24, 18, 31, 40, 183); // local time
    assert.match(localStamp(at), /^2026-10-24T18:31:40\.183[+-]\d{2}:\d{2}$/);
    const line = formatLine(record(), at);
    assert.doesNotMatch(line, /\n/);
    const o = JSON.parse(line);
    assert.deepEqual(Object.keys(o), KEYS);
    assert.deepEqual(o, {
      logId: 42,
      timestamp: localStamp(at),
      level: 'ERROR',
      outcome: 'not delivered',
      category: 'message',
      event: 'message.status',
      action: "Update a sent message's delivery status",
      reason: 'Meta\'s webhook reported the message as "failed" (it was "sent")',
      source: 'src/messages.ts:262 logStatus',
      direction: 'out',
      previousStatus: 'sent',
      newStatus: 'failed',
      requestId: 'req-1234abcd',
      messageId: 'm1',
      waMessageId: 'wamid.ABC',
      waMessageRef: 'wa:0123456789abcdef',
      conversationId: 'c1',
      messageSent: 1,
      customerReceived: 0,
      deliveryStatus: 'failed',
      workspaceId: 'w1',
      userId: null,
      durationMs: null,
      errorCode: 131049,
      errorDetails: 'This message was not delivered to maintain healthy ecosystem engagement.',
      message: "WhatsApp didn't deliver a message",
      content: null,
      request: null,
      response: null,
      data: { type: 'template' },
    });
  });
  test('fields that do not apply are null (still there, so every line can be read the same way)', () => {
    const o = JSON.parse(formatLine(record({ logId: null, direction: null, messageId: null, waMessageRef: null, messageSent: null, customerReceived: null, deliveryStatus: null, conversationId: null, previousStatus: null, newStatus: null, errorCode: null, errorDetails: null, data: null }), new Date()));
    assert.deepEqual(Object.keys(o), KEYS);
    assert.equal(o.direction, null);
    assert.equal(o.data, null);
  });
  test('line breaks and quotes in values stay inside the JSON (one entry, one line)', () => {
    const line = formatLine(record({ message: 'line one\nline "two"' }), new Date());
    assert.doesNotMatch(line, /\n/);
    assert.equal(JSON.parse(line).message, 'line one\nline "two"');
  });
});

describe('writing', () => {
  test("logEvent appends the sanitized entry to today's file (YYYY-MM-DD.log), with the request id", async () => {
    await runWithRequest('req-file-0001', () =>
      logEvent({ level: 'WARNING', category: 'auth', event: 'login.failed', message: 'Sign-in refused: wrong password', errorCode: 'INVALID_CREDENTIALS', direction: 'in', status: 401, data: { email: 'a@example.com', password: 'hunter2' } }),
    );
    await logEvent({ level: 'SUCCESS', category: 'http', event: 'http.request', message: 'POST /inbox → 200', fileOnly: true });
    await flushLogFile();
    const file = path.join(dir, `${localDay()}.log`);
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual([lines[0].level, lines[0].event, lines[0].requestId, lines[0].errorCode, lines[0].direction, lines[0].newStatus], ['WARNING', 'login.failed', 'req-file-0001', 'INVALID_CREDENTIALS', 'in', 401]);
    // No reason given: the event's default (never empty), and the source is this test file
    assert.deepEqual([lines[0].action, lines[0].reason, lines[0].outcome], ['Sign a user in', 'A sign-in attempt was refused', 'warning']);
    assert.match(lines[0].source, /^test\/logFile\.test\.ts:\d+/);
    assert.deepEqual(lines[0].data, { email: 'a@example.com', password: '[REDACTED]' });
    assert.doesNotMatch(JSON.stringify(lines), /hunter2/);
    assert.deepEqual([lines[1].event, lines[1].message], ['http.request', 'POST /inbox → 200']);
  });
  test('a new day starts a new file; earlier lines stay where they were', async () => {
    writeLogLine(record({ message: 'day one' }), new Date(2026, 0, 1, 23, 59));
    writeLogLine(record({ message: 'day two' }), new Date(2026, 0, 2, 0, 1));
    await flushLogFile();
    await new Promise((r) => setTimeout(r, 50)); // the previous day's file finishes closing
    assert.match(await readFile(path.join(dir, '2026-01-01.log'), 'utf8'), /day one/);
    assert.match(await readFile(path.join(dir, '2026-01-02.log'), 'utf8'), /day two/);
    assert.doesNotMatch(await readFile(path.join(dir, '2026-01-02.log'), 'utf8'), /day one/);
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
    // Today's names (YYYY-MM-DD.log) and the older app-YYYY-MM-DD.log are both kept to the same retention
    for (const name of ['app-2026-08-01.log', '2026-08-02.log', 'app-2026-09-23.log', '2026-09-24.log', 'app-2026-10-24.log', 'notes.txt', 'app-latest.log'])
      await writeFile(path.join(files, name), 'x'.repeat(100));

    const dry = await pruneLogFiles({ days: 30, now, dir: files });
    assert.equal(dry.cutoffDay, '2026-09-24');
    assert.deepEqual(dry.files, ['2026-08-02.log', 'app-2026-08-01.log', 'app-2026-09-23.log']);
    assert.deepEqual([dry.bytes, dry.deleted, dry.dryRun], [300, 0, true]);
    assert.equal((await readdir(files)).length, 7, 'nothing deleted');
    assert.match(describeFiles(dry), /^Dry run: 3 log files are from before 2026-09-24 .*nothing deleted$/);

    const done = await pruneLogFiles({ days: 30, now, dir: files, dryRun: false });
    assert.equal(done.deleted, 3);
    assert.deepEqual((await readdir(files)).sort(), ['2026-09-24.log', 'app-2026-10-24.log', 'app-latest.log', 'notes.txt']);
  });
  test('a missing folder has no files; bad days are refused', async () => {
    assert.deepEqual((await pruneLogFiles({ days: 30, dir: path.join(dir, 'missing') })).files, []);
    await assert.rejects(pruneLogFiles({ days: 0, dir }), /whole number of days/);
  });
});
