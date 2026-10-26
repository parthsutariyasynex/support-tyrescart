// Centralized backend logging: one structured entry (SUCCESS / WARNING / ERROR) per notable event, saved in the
// LogEntry table and appended to a daily log file (logs/app-YYYY-MM-DD.log, see logFile.ts). Logging must never break or slow down what it describes: logEvent() never throws, isn't awaited
// by callers, and when the database can't be written the same entry is printed to the terminal instead.
// Every entry is sanitized first (passwords, tokens and secrets redacted, long values cut), and carries the id of
// the request that caused it, so one request can be followed through every event it led to.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { writeLogLine } from './logFile.js';

export type LogLevel = 'SUCCESS' | 'WARNING' | 'ERROR';
export type LogCategory = 'http' | 'graphql' | 'auth' | 'permission' | 'whatsapp' | 'webhook' | 'message' | 'system';

export type LogInput = {
  level: LogLevel;
  category: LogCategory;
  event: string;
  message: string;
  // Taken from the current request when left out
  requestId?: string | null;
  workspaceId?: string | null;
  userId?: string | null;
  errorCode?: string | number | null;
  durationMs?: number | null;
  data?: Record<string, unknown>;
};

export type LogRecord = {
  level: LogLevel;
  category: LogCategory;
  event: string;
  message: string;
  requestId: string | null;
  workspaceId: string | null;
  userId: string | null;
  errorCode: string | null;
  durationMs: number | null;
  data: unknown;
};

// --- Request id (and who is signed in) for the request being handled, without passing it through every call ---

type RequestContext = { requestId: string; userId?: string; workspaceId?: string };
const requestContext = new AsyncLocalStorage<RequestContext>();

// A request id sent by a proxy or the client is reused only if it looks like one; otherwise a new one is made
export function requestIdFrom(header: unknown) {
  return typeof header === 'string' && /^[A-Za-z0-9._:-]{8,64}$/.test(header) ? header : randomUUID();
}

export function runWithRequest<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn);
}

export const currentRequestId = () => requestContext.getStore()?.requestId;

// Once the token is checked: later entries of this request name the person and workspace
export function setRequestUser(auth: { userId: string; workspaceId: string } | null | undefined) {
  const store = requestContext.getStore();
  if (store && auth) Object.assign(store, { userId: auth.userId, workspaceId: auth.workspaceId });
}

// --- Sanitizing ---

const MAX_STRING = 500;
const MAX_MESSAGE = 1000;
const MAX_ITEMS = 20;
const MAX_DEPTH = 4;
const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|signature|credential|otp|hash/i;
const REDACTED = '[REDACTED]';

function cleanString(s: string, max = MAX_STRING) {
  const redacted = s
    // A credential is long; ordinary words after "OAuth" (e.g. Meta's "Invalid OAuth access token") stay readable
    .replace(/\b(Bearer|OAuth|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, `$1 ${REDACTED}`)
    .replace(/\b((?:access_)?token|password|secret|signature|key)=([^&\s"']+)/gi, `$1=${REDACTED}`);
  return redacted.length > max ? `${redacted.slice(0, max)}… (+${redacted.length - max} chars)` : redacted;
}

// Text cut to fit a column of max characters, with the same redaction as every logged value. Never longer than max
// (counted as the database counts: whole characters, so an emoji is never split); a cut one ends in "…".
export function fitText(text: string, max = MAX_STRING) {
  const chars = Array.from(cleanString(String(text ?? ''), Number.MAX_SAFE_INTEGER));
  return chars.length <= max ? chars.join('') : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

// A copy that is safe to store and print: sensitive keys redacted, bearer tokens in text removed, long strings and
// arrays cut, nesting and cycles limited. Never throws.
export function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  try {
    if (value === null || value === undefined) return value ?? null;
    if (typeof value === 'string') return cleanString(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (Buffer.isBuffer(value)) return `[${value.length} bytes]`;
    if (value instanceof Error)
      return sanitize({ name: value.name, message: value.message, ...('code' in value ? { code: (value as any).code } : {}) }, depth, seen);
    if (typeof value !== 'object') return String(value);
    if (seen.has(value)) return '[Circular]';
    if (depth >= MAX_DEPTH) return '[Truncated]';
    seen.add(value);
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ITEMS).map((v) => sanitize(v, depth + 1, seen) ?? null);
      return value.length > MAX_ITEMS ? [...items, `… (+${value.length - MAX_ITEMS} more)`] : items;
    }
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      const clean = SENSITIVE_KEY.test(key) ? REDACTED : sanitize(v, depth + 1, seen);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  } catch {
    return '[Unreadable]';
  }
}

// HTTP status → level: server errors are ERROR, refusals (4xx) WARNING, everything else SUCCESS
export function outcomeForStatus(status: number): LogLevel {
  return status >= 500 ? 'ERROR' : status >= 400 ? 'WARNING' : 'SUCCESS';
}

// --- Writing ---

export function toRecord(input: LogInput): LogRecord {
  const ctx = requestContext.getStore();
  const data = input.data === undefined ? null : sanitize(input.data);
  return {
    level: input.level,
    category: input.category,
    event: String(input.event).slice(0, 100),
    message: cleanString(String(input.message ?? ''), MAX_MESSAGE),
    requestId: input.requestId ?? ctx?.requestId ?? null,
    workspaceId: input.workspaceId ?? ctx?.workspaceId ?? null,
    userId: input.userId ?? ctx?.userId ?? null,
    errorCode: input.errorCode === null || input.errorCode === undefined || input.errorCode === '' ? null : String(input.errorCode).slice(0, 50),
    durationMs: typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) ? Math.max(0, Math.round(input.durationMs)) : null,
    data: data && typeof data === 'object' && Object.keys(data).length ? data : null,
  };
}

// Prints an entry to the terminal: used when it couldn't be saved (reason = why), so nothing is lost silently
export function logToConsole(record: LogRecord, reason?: string) {
  const print = record.level === 'ERROR' ? console.error : record.level === 'WARNING' ? console.warn : console.log;
  const meta = Object.fromEntries(
    Object.entries({ requestId: record.requestId, workspaceId: record.workspaceId, userId: record.userId, errorCode: record.errorCode, durationMs: record.durationMs, data: record.data }).filter(
      ([, v]) => v !== null,
    ),
  );
  try {
    print(`[log${reason ? ', not saved' : ''}] ${record.level} ${record.category} ${record.event}: ${record.message}`, meta);
  } catch {
    // the terminal itself is gone: nothing left to do
  }
}

type Writer = (record: LogRecord) => Promise<unknown>;
const dbWriter: Writer = (r) =>
  prisma.logEntry.create({ data: { ...r, data: r.data === null ? Prisma.DbNull : (r.data as Prisma.InputJsonValue) } });
let writer: Writer = dbWriter;

// Tests only: replace (or restore, with no argument) where entries are written
export function setLogWriter(next?: Writer) {
  writer = next ?? dbWriter;
  lastFailure = null;
}

// The database problem last reported, so the terminal says once why entries are being printed instead of saved
let lastFailure: string | null = null;

function reportFailure(err: unknown) {
  const text = err instanceof Error ? (err.message.split('\n').filter(Boolean).pop() ?? err.message) : String(err);
  const reason = cleanString(text.trim().replace(/\.+$/, ''), 300);
  if (reason !== lastFailure) {
    lastFailure = reason;
    console.warn(`[log] Couldn't save logs to the database (LogEntry): ${reason}. They are printed to the terminal until it works again.`);
  }
  return reason;
}

// Records one event. Never throws and never needs awaiting (the promise always resolves; tests await it).
export function logEvent(input: LogInput): Promise<void> {
  let record: LogRecord;
  try {
    record = toRecord(input);
  } catch {
    return Promise.resolve();
  }
  writeLogLine(record); // never throws; the file gets it whatever happens to the database write
  try {
    return writer(record).then(
      () => {
        lastFailure = null;
      },
      (err) => logToConsole(record, reportFailure(err)),
    );
  } catch (err) {
    logToConsole(record, reportFailure(err));
    return Promise.resolve();
  }
}

// --- Shared helpers for the places that log ---

// The code worth keeping from any error: Meta's numeric code (GraphApiError), or an AppError/GraphQL code
export function errorCodeOf(err: unknown): string | number | null {
  const e = err as any;
  return e?.code ?? e?.extensions?.code ?? null;
}

// Outgoing messages: whether WhatsApp accepted it (sent) or refused it, after a send attempt
export function logMessageSend(p: { workspaceId: string; conversationId: string; messageId: string; type: string; userId?: string | null; automation?: string; error?: unknown }) {
  const data = { conversationId: p.conversationId, messageId: p.messageId, type: p.type, ...(p.automation ? { automation: p.automation } : {}) };
  if (p.error === undefined)
    return logEvent({ level: 'SUCCESS', category: 'message', event: 'message.sent', message: `Sent a message (${p.type})`, workspaceId: p.workspaceId, userId: p.userId, data });
  return logEvent({
    level: 'ERROR',
    category: 'message',
    event: 'message.send_failed',
    message: `WhatsApp refused a message (${p.type}): ${(p.error as Error)?.message ?? String(p.error)}`,
    workspaceId: p.workspaceId,
    userId: p.userId,
    errorCode: errorCodeOf(p.error),
    data,
  });
}
