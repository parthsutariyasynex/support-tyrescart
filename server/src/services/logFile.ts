// Backend logs as daily files: one JSON object per line (JSON Lines), one file per day in the server's time zone,
// e.g. logs/2026-10-26.log. Every line has the same keys (null where they don't apply), so it can be searched with
// grep or jq and parsed line by line; the database copy (LogEntry) has the same entries. The folder is
// LOG_DIR (default: logs/ where the server runs); LOG_TO_FILE=false turns the files off. Writing is buffered, never
// throws and never holds up a request: if the folder can't be written, the terminal says why (once) and the next
// entry tries again. Entries are already sanitized by logging.ts (no passwords, tokens or customer data).
// Every entry has a logId: 1, 2, 3… in the order entries are written, continuing after a restart from the highest
// logId in the newest files of the folder (older lines without one are skipped). One server process writes the files;
// a separate process writing to the same folder at the same time (e.g. npm run logs:retention) could repeat a number.
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../env.js';
import type { LogRecord } from './logging.js';

// YYYY-MM-DD.log (and the older app-YYYY-MM-DD.log, so retention still finds those)
export const LOG_FILE_PATTERN = /^(?:app-)?(\d{4}-\d{2}-\d{2})\.log$/;

let dir: string | null = env.logToFile ? env.logDir : null;
let stream: fs.WriteStream | null = null;
let streamDay = '';
let lastError: string | null = null;
// The last logId given out (null: not read from the folder yet)
let lastLogId: number | null = null;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

// YYYY-MM-DD in the server's time zone (the day a file covers)
export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 2026-10-26T18:31:40.183+05:30: ISO 8601 in the server's time zone, with its offset (never ambiguous)
export function localStamp(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${localDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

// The highest logId in the folder's newest dated files (read from the end of each; the first file that has any wins)
export function highestLogId(folder: string | null): number {
  if (!folder) return 0;
  let files: string[];
  try {
    files = fs.readdirSync(folder).filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort().reverse();
  } catch {
    return 0;
  }
  for (const f of files.slice(0, 7)) {
    try {
      const file = path.join(folder, f);
      const size = fs.statSync(file).size;
      const length = Math.min(size, 256 * 1024);
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(length);
      try {
        fs.readSync(fd, buf, 0, length, size - length);
      } finally {
        fs.closeSync(fd);
      }
      let max = 0;
      for (const m of buf.toString('utf8').matchAll(/"logId":(\d+)/g)) max = Math.max(max, Number(m[1]));
      if (max) return max;
    } catch {
      // unreadable file: try the one before
    }
  }
  return 0;
}

// The next logId (sequential; continues from the folder's files after a restart)
export function nextLogId() {
  if (lastLogId === null) lastLogId = highestLogId(dir);
  lastLogId += 1;
  return lastLogId;
}

// One entry as one JSON line, keys always in this order: its number and when, how it ended, what happened and why,
// where in the code, the status before and after, the ids to follow it, the delivery tracking, how long it took, and
// the actual response or error
export function formatLine(r: LogRecord, at: Date = r.at ?? new Date()) {
  return JSON.stringify({
    logId: r.logId ?? null,
    timestamp: localStamp(at),
    level: r.level,
    outcome: r.outcome ?? null,
    category: r.category,
    event: r.event,
    action: r.action ?? null,
    reason: r.reason ?? null,
    source: r.source ?? null,
    direction: r.direction ?? null,
    previousStatus: r.previousStatus ?? null,
    newStatus: r.newStatus ?? null,
    requestId: r.requestId,
    messageId: r.messageId ?? null,
    waMessageId: r.waMessageId ?? null,
    waMessageRef: r.waMessageRef ?? null,
    conversationId: r.conversationId ?? null,
    messageSent: r.messageSent ?? null,
    customerReceived: r.customerReceived ?? null,
    deliveryStatus: r.deliveryStatus ?? null,
    workspaceId: r.workspaceId,
    userId: r.userId,
    durationMs: r.durationMs,
    errorCode: r.errorCode,
    errorDetails: r.errorDetails ?? null,
    message: r.message,
    content: r.content ?? null,
    request: r.request ?? null,
    response: r.response ?? null,
    data: r.data ?? null,
  });
}

function report(err: unknown) {
  const reason = (err as Error)?.message ?? String(err);
  stream = null; // the next entry opens the file again
  if (reason === lastError) return;
  lastError = reason;
  try {
    console.warn(`[log] Couldn't write the log file in ${dir}: ${reason}`);
  } catch {
    // nothing left to tell
  }
}

// Appends one entry to today's file. Never throws.
export function writeLogLine(record: LogRecord, at: Date = record.at ?? new Date()) {
  if (!dir) return;
  try {
    const day = localDay(at);
    if (!stream || streamDay !== day) {
      stream?.end();
      fs.mkdirSync(dir, { recursive: true });
      const next = fs.createWriteStream(path.join(dir, `${day}.log`), { flags: 'a' });
      next.on('error', (err) => {
        if (stream === next) report(err);
      });
      next.on('open', () => (lastError = null));
      stream = next;
      streamDay = day;
    }
    stream.write(`${formatLine(record, at)}\n`);
  } catch (err) {
    report(err);
  }
}

// Writes one entry right away (not buffered): for the last entry before the process exits, e.g. a crash
export function writeLogLineSync(record: LogRecord, at: Date = record.at ?? new Date()) {
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${localDay(at)}.log`), `${formatLine(record, at)}\n`);
  } catch (err) {
    report(err);
  }
}

// Resolves once everything written so far is in the file (tests, and before the process exits)
export function flushLogFile(): Promise<void> {
  const s = stream;
  if (!s || s.destroyed) return Promise.resolve();
  return new Promise((resolve) => s.write('', () => resolve()));
}

export const logFileDir = () => dir;

// Tests: write to another folder (or null: no files); no argument goes back to LOG_DIR / LOG_TO_FILE
export function setLogFileDir(next?: string | null) {
  stream?.end();
  stream = null;
  streamDay = '';
  lastError = null;
  lastLogId = null;
  dir = next === undefined ? (env.logToFile ? env.logDir : null) : next;
}
