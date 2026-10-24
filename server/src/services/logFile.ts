// Backend logs as plain text files, next to the database copy (LogEntry): one line per entry, one file per day in the
// server's time zone, e.g. logs/app-2026-10-24.log. Readable with any editor, `tail -f` or grep. The folder is
// LOG_DIR (default: logs/ where the server runs); LOG_TO_FILE=false turns the files off. Writing is buffered, never
// throws and never holds up a request: if the folder can't be written, the terminal says why (once) and the next
// entry tries again. Entries are already sanitized by logging.ts (no passwords, tokens or customer data).
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../env.js';
import type { LogRecord } from './logging.js';

export const LOG_FILE_PATTERN = /^app-(\d{4}-\d{2}-\d{2})\.log$/;

let dir: string | null = env.logToFile ? env.logDir : null;
let stream: fs.WriteStream | null = null;
let streamDay = '';
let lastError: string | null = null;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

// YYYY-MM-DD in the server's time zone (the day a file covers)
export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 2026-10-24 18:31:40.183 +05:30: local time with its offset, so a line is never ambiguous
export function localStamp(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${localDay(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)} ${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

// One entry as one line: time, level, event, message, then the ids and data that are set
export function formatLine(r: LogRecord, at = new Date()) {
  const oneLine = (s: string) => s.replace(/\r?\n/g, ' ⏎ ');
  const parts = [localStamp(at), r.level.padEnd(7), r.event, oneLine(r.message)];
  const tags = [
    r.requestId && `req=${r.requestId}`,
    r.workspaceId && `workspace=${r.workspaceId}`,
    r.userId && `user=${r.userId}`,
    r.errorCode && `code=${r.errorCode}`,
    r.durationMs !== null && `${r.durationMs}ms`,
    r.data !== null && `data=${JSON.stringify(r.data)}`,
  ].filter(Boolean);
  return `${parts.join(' ')}${tags.length ? ` | ${tags.join(' ')}` : ''}`;
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
export function writeLogLine(record: LogRecord, at = new Date()) {
  if (!dir) return;
  try {
    const day = localDay(at);
    if (!stream || streamDay !== day) {
      stream?.end();
      fs.mkdirSync(dir, { recursive: true });
      const next = fs.createWriteStream(path.join(dir, `app-${day}.log`), { flags: 'a' });
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
  dir = next === undefined ? (env.logToFile ? env.logDir : null) : next;
}
