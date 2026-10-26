// Centralized backend logging: one structured entry (SUCCESS / WARNING / ERROR) per event, appended as one JSON line
// to the day's log file (logs/YYYY-MM-DD.log, see logFile.ts) and saved in the LogEntry table (high-volume entries,
// e.g. every HTTP request, go to the file only). Logging must never break or slow down what it describes: logEvent()
// never throws, isn't awaited by callers, and when the database can't be written the entry is printed to the
// terminal too (it is in the file regardless).
// Each entry explains itself: what was done (action), why it was logged (reason: what triggered it), where in the
// code (source: file, line, function), the outcome, the status before and after, the direction (in: from a customer
// / client, out: to WhatsApp), the message (our id and WhatsApp's) and conversation, the API's or database's actual
// response, the error code and details, and how long it took. Every event has a default action and reason (EVENTS
// below); call sites add specifics.
// Every entry is sanitized first (passwords, tokens and secrets redacted, long values cut), and carries the id of
// the request that caused it, so one request can be followed through every event it led to.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { type DbError, prisma, setDbErrorReporter } from '../prisma.js';
import { writeLogLine, writeLogLineSync } from './logFile.js';

export type LogLevel = 'SUCCESS' | 'WARNING' | 'ERROR';
export type LogCategory = 'http' | 'graphql' | 'auth' | 'permission' | 'whatsapp' | 'webhook' | 'message' | 'system' | 'socket' | 'database';
export type Direction = 'in' | 'out';

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
  // in: arriving (a customer's message, a webhook, a client's request); out: going out (to WhatsApp)
  direction?: Direction | null;
  // Our message id, WhatsApp's (wamid), and the chat
  messageId?: string | null;
  waMessageId?: string | null;
  conversationId?: string | null;
  // The status after the event (sent, delivered, read, failed, received, 200, closed…); same as newStatus
  status?: string | number | null;
  newStatus?: string | number | null;
  // The status before it (pending, delivered, open, the previous assignee…), when something changed state
  previousStatus?: string | number | null;
  // What was done, and why it was logged (the trigger). Default: EVENTS[event]; give them for specifics
  action?: string;
  reason?: string;
  // succeeded | failed | refused | skipped | ignored | duplicate | aborted … (default from the level)
  outcome?: string;
  // Where in the code (default: the file, line and function that logged it)
  source?: string;
  // What the other side answered (sanitized): Meta's reply, the HTTP response's status and size…
  response?: unknown;
  // The error in words (its message, Meta's title and details), beside errorCode
  errorDetails?: string | null;
  data?: Record<string, unknown>;
  // Only to the log file, not the database (very frequent entries, e.g. each HTTP request)
  fileOnly?: boolean;
};

export type LogRecord = {
  level: LogLevel;
  category: LogCategory;
  event: string;
  message: string;
  requestId: string | null;
  workspaceId: string | null;
  userId: string | null;
  // A number when the code is numeric (Meta's 131049, HTTP 401), text otherwise (P2002, FORBIDDEN)
  errorCode: string | number | null;
  durationMs: number | null;
  direction: Direction | null;
  messageId: string | null;
  waMessageId: string | null;
  conversationId: string | null;
  // Text (sent, open…) or a number (an HTTP status)
  previousStatus: string | number | null;
  newStatus: string | number | null;
  action: string;
  reason: string;
  outcome: string;
  source: string | null;
  response: unknown;
  errorDetails: string | null;
  data: unknown;
  // When it happened (set when the entry is made, so the file and the database agree)
  at: Date;
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
    // Numeric ids (e.g. imported BigInt user ids) stay numbers when JSON can hold them exactly
    if (typeof value === 'bigint') return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value.toString();
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

const idOrNull = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 191) : null);
const statusOrNull = (v: unknown) => (v === null || v === undefined || v === '' ? null : typeof v === 'number' && Number.isFinite(v) ? v : String(v).slice(0, 50));
// Numeric codes stay numbers (Meta's 131049, an HTTP status); anything else is text (P2002, FORBIDDEN)
const codeOrNull = (v: unknown) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const text = String(v).slice(0, 50);
  return /^\d{1,15}$/.test(text) ? Number(text) : text;
};

// --- What each event is: the action it records and what triggers it (the default reason) ---

type EventInfo = { action: string; reason: string };
export const EVENTS: Record<string, EventInfo> = {
  'http.request': { action: 'Handle an HTTP request', reason: 'A client (the web app, Meta or a browser) called the API' },
  'http.aborted': { action: 'Handle an HTTP request', reason: 'The client closed the connection before the API answered' },
  'http.unhandled_error': { action: 'Handle an HTTP request', reason: 'Code behind an API route threw an error nobody caught' },
  'graphql.mutation': { action: 'Run a GraphQL mutation', reason: 'A user did something in the web app (send, assign, close…)' },
  'graphql.query': { action: 'Run a GraphQL query', reason: 'The web app asked for data and an unexpected error happened' },
  'graphql.subscription': { action: 'Run a GraphQL subscription', reason: 'The web app subscribed and an unexpected error happened' },
  'graphql.unknown': { action: 'Run a GraphQL operation', reason: 'The web app called the API and an unexpected error happened' },
  'login.success': { action: 'Sign a user in', reason: 'Someone signed in with a correct email and password' },
  'login.failed': { action: 'Sign a user in', reason: 'A sign-in attempt was refused' },
  'permission.denied': { action: 'Check what the user may do', reason: "Someone tried an action their role doesn't allow" },
  'message.received': { action: 'Save an incoming WhatsApp message', reason: "Meta's webhook delivered a customer's message" },
  'message.duplicate': { action: 'Save an incoming WhatsApp message', reason: 'Meta sent a message again that was already saved (webhooks are retried)' },
  'message.media_failed': { action: "Download a customer's file from WhatsApp", reason: 'A customer sent a file and fetching it from Meta failed' },
  'message.sent': { action: 'Send a message to the customer on WhatsApp', reason: 'A message was sent from the chat' },
  'message.send_failed': { action: 'Send a message to the customer on WhatsApp', reason: 'A message was sent from the chat and WhatsApp refused it' },
  'message.status': { action: "Update a sent message's delivery status", reason: "Meta's webhook reported the message's new status" },
  'message.status_stale': { action: "Update a sent message's delivery status", reason: 'Meta reported a status older than the one already known (out of order)' },
  'message.status_unmatched': { action: "Update a sent message's delivery status", reason: "Meta reported a status for a message this app doesn't have" },
  'automation.auto_reply_discarded': { action: 'Send the automatic reply', reason: 'The chat was deleted while WhatsApp was still answering' },
  'automation.failed': { action: 'Run Simple automations on an incoming message', reason: "A customer's message arrived and the automations threw an error" },
  'automation.routing_failed': { action: 'Assign a new chat automatically (routing)', reason: 'A new chat arrived and automatic routing failed' },
  'automation.auto_reply_failed': { action: 'Send the automatic reply', reason: "A customer's message arrived and the auto-reply failed" },
  'conversation.status_changed': { action: "Change a chat's status (open, snoozed, closed)", reason: 'A teammate closed, reopened or snoozed the chat' },
  'conversation.woken': { action: 'Reopen a snoozed chat', reason: 'The snooze time ended, or the customer wrote' },
  'conversation.assigned': { action: 'Change who a chat is assigned to', reason: 'A chat was assigned, reassigned or unassigned' },
  'conversation.deleted_for_user': { action: 'Delete a chat from one person\'s list', reason: 'A teammate chose Delete chat and confirmed' },
  'live.started': { action: 'Start sharing a live location', reason: 'A teammate chose Share live location in the chat' },
  'live.stopped': { action: 'Stop sharing a live location', reason: 'A teammate (or an admin) pressed Stop sharing' },
  'webhook.received': { action: "Process one of Meta's webhooks", reason: 'Meta called the webhook (messages, statuses, calls or other updates)' },
  'webhook.invalid_signature': { action: "Check a webhook's signature", reason: "A webhook's signature didn't match the app secret, so it was rejected" },
  'webhook.unknown_number': { action: "Process one of Meta's webhooks", reason: 'The webhook was for a WhatsApp number not connected to any workspace' },
  'webhook.message_failed': { action: 'Save an incoming WhatsApp message', reason: 'Saving one message of a webhook threw an error (the rest continued)' },
  'webhook.status_failed': { action: "Update a sent message's delivery status", reason: 'Applying one status of a webhook threw an error (the rest continued)' },
  'webhook.failed': { action: "Process one of Meta's webhooks", reason: 'Processing the webhook threw an error' },
  'webhook.reaction': { action: "Apply a customer's emoji reaction", reason: 'A customer reacted to (or un-reacted) one of the messages' },
  'webhook.reaction_unmatched': { action: "Apply a customer's emoji reaction", reason: "A customer reacted to a message this workspace doesn't have" },
  'webhook.notice': { action: "Process one of Meta's webhooks", reason: "Meta sent a notice that isn't a customer's message (not saved)" },
  'socket.connected': { action: 'Open a live connection', reason: "A teammate's browser connected for live updates" },
  'socket.disconnected': { action: 'Close a live connection', reason: "A teammate's browser left, reloaded or lost its connection" },
  'socket.unauthorized': { action: 'Open a live connection', reason: 'A browser tried to connect without a valid sign-in' },
  'socket.error': { action: 'Keep a live connection', reason: 'The live connection reported an error' },
  'socket.emit': { action: "Tell the team's open apps about a change", reason: 'Something changed that the open apps show (message, status, chat…)' },
  'database.error': { action: 'Run a database query', reason: 'The database refused or failed a query' },
  'database.engine': { action: 'Keep the database connection', reason: 'The database engine reported a problem (connection, pool…)' },
  'activity.failed': { action: "Record an entry in a chat's history", reason: 'Writing the history entry failed' },
  'email.failed': { action: 'Send an email', reason: 'The mail server refused or failed the email' },
  'email.not_sent': { action: 'Send an email', reason: 'Email is not set up on this server (SMTP)' },
  'file.missing': { action: 'Read a stored file', reason: "The file is in the database but not on the server's disk" },
  'file.remove_failed': { action: 'Remove a stored file', reason: "A file that is no longer needed couldn't be deleted from disk" },
  'job.purge_failed': { action: 'Purge deleted contacts (hourly job)', reason: 'The scheduled purge threw an error' },
  'job.reminders_failed': { action: 'Remind assignees of waiting chats (scheduled job)', reason: 'The scheduled reminder check threw an error' },
  'job.snooze_failed': { action: 'Reopen snoozed chats whose time has come (scheduled job)', reason: 'The scheduled check threw an error' },
  'settings.refresh_failed': { action: "Refresh a workspace's settings", reason: 'Reading the settings from the database failed (the last ones are kept)' },
  'server.started': { action: 'Start the API server', reason: 'The server process was started (deploy, restart or development reload)' },
  'server.stopping': { action: 'Stop the API server', reason: 'The process was asked to stop (a signal: restart, deploy or shutdown)' },
  'server.crashed': { action: 'Run the API server', reason: 'An error nobody caught reached the top of the process, so Node.js is stopping it' },
  'logs.retention': { action: 'Apply log retention (daily job)', reason: 'The daily job checked for old log entries and files' },
  'whatsapp.connect_unreachable': { action: 'Check a WhatsApp number with Meta', reason: "An admin connected a number and Meta couldn't be reached" },
};
// Meta API calls (whatsapp.send, whatsapp.upload_media…): one rule for all
const WHATSAPP_CALL: EventInfo = { action: "Call Meta's WhatsApp API", reason: 'The app needed Meta to do something (send, upload, templates…)' };
export function eventInfo(event: string): EventInfo | null {
  return EVENTS[event] ?? (event.startsWith('whatsapp.') ? { ...WHATSAPP_CALL, action: `Call Meta's WhatsApp API (${event.slice(9)})` } : null);
}

const OUTCOME_OF: Record<LogLevel, string> = { SUCCESS: 'succeeded', WARNING: 'warning', ERROR: 'failed' };

// Where in the code an entry was made: the first stack frame outside the logging itself, as
// "src/services/inbox.ts:465 sendMessage" (relative to the server folder; never a full path or node_modules)
const SKIP_FRAME = /[\\/](services[\\/](logging|logFile)\.ts|prisma\.ts)|node_modules|^node:|^native/;
export function callerSource(stack = new Error().stack ?? '') {
  for (const line of stack.split('\n').slice(1)) {
    const m = /at (?:async )?(?:(.+?) \()?(?:file:\/\/)?(.+?):(\d+):\d+\)?$/.exec(line.trim());
    if (!m || SKIP_FRAME.test(m[2])) continue;
    const at = m[2].includes('/src/') ? `src/${m[2].split('/src/').pop()}` : m[2].includes('/test/') ? `test/${m[2].split('/test/').pop()}` : m[2].split(/[\\/]/).pop();
    const fn = m[1] && !m[1].includes('<anonymous>') ? ` ${m[1].replace(/^async /, '').replace(/^(Module|Object)\./, '')}` : '';
    return `${at}:${m[3]}${fn}`;
  }
  return null;
}

export function toRecord(input: LogInput): LogRecord {
  const ctx = requestContext.getStore();
  const data = input.data === undefined ? null : sanitize(input.data);
  const response = input.response === undefined || input.response === null ? null : sanitize(input.response);
  const info = eventInfo(String(input.event));
  return {
    level: input.level,
    category: input.category,
    event: String(input.event).slice(0, 100),
    message: cleanString(String(input.message ?? ''), MAX_MESSAGE),
    requestId: input.requestId ?? ctx?.requestId ?? null,
    workspaceId: input.workspaceId ?? ctx?.workspaceId ?? null,
    userId: input.userId ?? ctx?.userId ?? null,
    errorCode: codeOrNull(input.errorCode),
    durationMs: typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) ? Math.max(0, Math.round(input.durationMs)) : null,
    direction: input.direction === 'in' || input.direction === 'out' ? input.direction : null,
    messageId: idOrNull(input.messageId),
    waMessageId: idOrNull(input.waMessageId),
    conversationId: idOrNull(input.conversationId),
    previousStatus: statusOrNull(input.previousStatus),
    newStatus: statusOrNull(input.newStatus ?? input.status),
    action: cleanString(input.action ?? info?.action ?? input.event, 200),
    reason: cleanString(input.reason ?? info?.reason ?? 'Not described', 300),
    outcome: (input.outcome ?? OUTCOME_OF[input.level] ?? 'unknown').slice(0, 30),
    source: input.source ?? null,
    response,
    errorDetails: input.errorDetails ? fitText(input.errorDetails, MAX_MESSAGE) : null,
    data: data && typeof data === 'object' && Object.keys(data).length ? data : null,
    at: new Date(),
  };
}

// The traceable fields not in LogEntry's own columns: kept in its data in the database (no schema change)
const EXTRA_FIELDS = ['action', 'reason', 'outcome', 'source', 'direction', 'previousStatus', 'newStatus', 'messageId', 'waMessageId', 'conversationId', 'response', 'errorDetails'] as const;
export function dataForDb(r: LogRecord) {
  const extra = Object.fromEntries(EXTRA_FIELDS.filter((k) => r[k] !== null && r[k] !== undefined).map((k) => [k, r[k]]));
  const merged = { ...extra, ...(r.data && typeof r.data === 'object' ? (r.data as Record<string, unknown>) : {}) };
  return Object.keys(merged).length ? merged : null;
}

// Prints an entry to the terminal: used when it couldn't be saved (reason = why), so nothing is lost silently
export function logToConsole(record: LogRecord, reason?: string) {
  const print = record.level === 'ERROR' ? console.error : record.level === 'WARNING' ? console.warn : console.log;
  const meta = Object.fromEntries(
    Object.entries({ requestId: record.requestId, workspaceId: record.workspaceId, userId: record.userId, errorCode: record.errorCode, durationMs: record.durationMs, data: dataForDb(record) }).filter(
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
const dbWriter: Writer = (r) => {
  const data = dataForDb(r);
  return prisma.logEntry.create({
    data: {
      createdAt: r.at,
      level: r.level,
      category: r.category,
      event: r.event,
      message: r.message,
      requestId: r.requestId,
      workspaceId: r.workspaceId,
      userId: r.userId,
      errorCode: r.errorCode === null ? null : String(r.errorCode), // the column is text
      durationMs: r.durationMs,
      data: data === null ? Prisma.DbNull : (data as Prisma.InputJsonValue),
    },
  });
};
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
// fileOnly entries go to the day's file only (if the file can't be written, the terminal says why).
export function logEvent(input: LogInput): Promise<void> {
  let record: LogRecord;
  try {
    record = toRecord(input);
    if (!record.source) record.source = callerSource();
  } catch (err) {
    try {
      console.warn('[log] Could not make a log entry:', (err as Error)?.message ?? err, { event: (input as any)?.event });
    } catch {
      // the terminal itself is gone
    }
    return Promise.resolve();
  }
  writeLogLine(record); // never throws; the file gets it whatever happens to the database write
  if (input.fileOnly) return Promise.resolve();
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

// For the very last entries of a process (a crash): written to the file at once, before the process exits; no
// database write (it couldn't finish). Never throws.
export function logEventSync(input: LogInput) {
  try {
    const record = toRecord(input);
    if (!record.source) record.source = callerSource();
    writeLogLineSync(record);
    logToConsole(record);
  } catch {
    // nothing more can be done while the process is going down
  }
}

// A crash (an error nobody caught, or a rejected promise nobody handled) is written to the log file before Node.js
// stops the process. Only a monitor: what happens next (the process exiting) is unchanged.
export function installCrashLogger() {
  process.on('uncaughtExceptionMonitor', (err, origin) =>
    logEventSync({
      level: 'ERROR',
      category: 'system',
      event: 'server.crashed',
      message: `The API is stopping: ${origin === 'unhandledRejection' ? 'a promise was rejected and nothing handled it' : 'an error was thrown and nothing caught it'}: ${(err as Error)?.message ?? String(err)}`,
      reason: origin === 'unhandledRejection' ? 'A rejected promise reached the top of the process unhandled' : 'An exception reached the top of the process uncaught',
      outcome: 'crashed',
      previousStatus: 'running',
      newStatus: 'stopped',
      errorCode: errorCodeOf(err),
      errorDetails: errorDetailsOf(err),
      data: { origin, name: (err as Error)?.name ?? null, stack: typeof (err as Error)?.stack === 'string' ? (err as Error).stack!.split('\n').slice(0, 8).join('\n') : null, pid: process.pid },
    }),
  );
}

// --- Shared helpers for the places that log ---

// The code worth keeping from any error: Meta's numeric code (GraphApiError), or an AppError/GraphQL code
export function errorCodeOf(err: unknown): string | number | null {
  const e = err as any;
  return e?.code ?? e?.extensions?.code ?? null;
}

// The error in words for errorDetails: its message, and Meta's details when it gave some
export function errorDetailsOf(err: unknown): string | null {
  if (err === undefined || err === null) return null;
  const e = err as any;
  const message = typeof e?.message === 'string' ? e.message : String(err);
  return typeof e?.details === 'string' && e.details && e.details !== message ? `${message}: ${e.details}` : message;
}

// Outgoing messages: whether WhatsApp accepted it (sent, with its message id) or refused it, after a send attempt
export function logMessageSend(p: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  type: string;
  userId?: string | null;
  automation?: string;
  error?: unknown;
  // WhatsApp's id for the message (when it accepted it)
  waMessageId?: string | null;
  durationMs?: number | null;
}) {
  const why =
    p.automation === 'auto_reply'
      ? "Automatic reply (Simple automations) to a customer's message"
      : ({
          template: 'A teammate sent an approved template, confirmed with "Yes, Send"',
          location: 'A teammate sent a location from the chat',
          live_location: 'A teammate started sharing a live location (the customer gets a link)',
          image: 'A teammate sent a photo from the chat',
          video: 'A teammate sent a video from the chat',
          document: 'A teammate sent a document from the chat',
          voice: 'A teammate sent a voice message from the chat',
        } as Record<string, string>)[p.type] ?? 'A teammate sent a message from the chat';
  const common = {
    category: 'message' as const,
    direction: 'out' as const,
    reason: why,
    previousStatus: 'pending',
    workspaceId: p.workspaceId,
    userId: p.userId,
    conversationId: p.conversationId,
    messageId: p.messageId,
    durationMs: p.durationMs,
    data: { type: p.type, ...(p.automation ? { automation: p.automation } : {}) },
  };
  if (p.error === undefined)
    return logEvent({ ...common, level: 'SUCCESS', event: 'message.sent', message: `Sent a message (${p.type}); WhatsApp accepted it`, outcome: 'sent', newStatus: 'sent', waMessageId: p.waMessageId, response: { waMessageId: p.waMessageId ?? null } });
  return logEvent({
    ...common,
    level: 'ERROR',
    event: 'message.send_failed',
    message: `WhatsApp refused a message (${p.type}): ${(p.error as Error)?.message ?? String(p.error)}`,
    outcome: 'failed',
    newStatus: 'failed',
    errorCode: errorCodeOf(p.error),
    errorDetails: errorDetailsOf(p.error),
    response: (p.error as any)?.status ? { httpStatus: (p.error as any).status, code: (p.error as any).code ?? null, subcode: (p.error as any).subcode ?? null, fbtraceId: (p.error as any).fbtraceId ?? null } : null,
  });
}

// Database errors (see prisma.ts): the model, operation and Prisma's code. Expected refusals the code handles
// (unique or missing rows, P2002/P2025) are WARNING; anything else ERROR. File and database, except engine errors
// (the database may be what's failing), which go to the file only.
const EXPECTED_DB_CODES = new Set(['P2002', 'P2025']);
export function logDbError(e: DbError) {
  const code = (e.error as any)?.code ?? null;
  const engine = e.model === null;
  return logEvent({
    level: code && EXPECTED_DB_CODES.has(code) ? 'WARNING' : 'ERROR',
    category: 'database',
    event: engine ? 'database.engine' : 'database.error',
    message: `Database ${engine ? e.operation : `${e.model}.${e.operation}`} failed: ${errorDetailsOf(e.error)?.split('\n').filter(Boolean).pop() ?? 'unknown error'}`,
    reason: engine
      ? 'The database engine reported a problem not tied to one query'
      : code === 'P2002'
        ? `${e.model}.${e.operation} would have created a duplicate (a unique value already exists)`
        : code === 'P2025'
          ? `${e.model}.${e.operation} found no matching row (already deleted or never there)`
          : `${e.model}.${e.operation} was refused by the database${code ? ` (${code})` : ''}`,
    outcome: code && EXPECTED_DB_CODES.has(code) ? 'refused' : 'failed',
    errorCode: code,
    errorDetails: errorDetailsOf(e.error),
    durationMs: e.durationMs,
    data: { model: e.model, operation: e.operation, target: (e.error as any)?.meta?.target ?? (e.error as any)?.target ?? null },
    fileOnly: engine,
  });
}
setDbErrorReporter((e) => void logDbError(e));

// A failure that the code carries on from (a background job, a best-effort clean-up, an email): recorded as ERROR
// (or WARNING), with its code and details, so it is never only in the terminal or lost
export function logFailure(
  event: string,
  message: string,
  err: unknown,
  extra: Partial<Pick<LogInput, 'workspaceId' | 'userId' | 'conversationId' | 'messageId' | 'level' | 'data' | 'reason' | 'action'>> & { category?: LogCategory } = {},
) {
  const { category = 'system', level = 'ERROR', ...rest } = extra;
  return logEvent({
    ...rest,
    level,
    category,
    event,
    message: `${message}: ${(err as Error)?.message ?? String(err)}`,
    outcome: 'failed',
    errorCode: errorCodeOf(err),
    errorDetails: errorDetailsOf(err),
  });
}
