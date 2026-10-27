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
// Customer data (LOG_CUSTOMER_DATA, default on): message text, the customer's number and name, WhatsApp's ids
// (wamid) and the full payloads exchanged with Meta are logged, so a message can be traced exactly. With
// LOG_CUSTOMER_DATA=false they stay out: numbers masked, text left out, wamids only as a one-way reference (waRef; a
// wamid holds the customer's number). Every entry about a message carries waRef either way. Secrets (passwords,
// tokens, signatures, one-time codes) are always redacted.
// Each entry gets a sequential logId (logFile.ts). An outgoing message can be followed from the send to Meta's answer
// to each delivery status: messageSent (1 Meta accepted it, 0 it was not sent, null unknown), customerReceived (1
// delivered or read, 0 confirmed failed, null not confirmed yet) and deliveryStatus (sent, delivered, read, failed),
// only ever set from what Meta actually answered or reported.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { env } from '../env.js';
import { type DbError, prisma, setDbErrorReporter } from '../prisma.js';
import { nextLogId, writeLogLine, writeLogLineSync } from './logFile.js';
import { explainMetaError } from './metaErrors.js';

export type LogLevel = 'SUCCESS' | 'WARNING' | 'ERROR';
export type LogCategory = 'http' | 'graphql' | 'auth' | 'permission' | 'whatsapp' | 'webhook' | 'message' | 'system' | 'socket' | 'database' | 'client';
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
  // Our message id, WhatsApp's (wamid: logged only as its waRef), and the chat. Inside withMessageTrace, the traced
  // message's ids are used when these are left out.
  messageId?: string | null;
  waMessageId?: string | null;
  conversationId?: string | null;
  // Outgoing messages, from what Meta answered or reported (never assumed): 1 Meta accepted it / 0 not sent / null
  // unknown (e.g. a timeout)
  messageSent?: 0 | 1 | null;
  // 1 delivered or read, 0 confirmed failed, null not confirmed (yet)
  customerReceived?: 0 | 1 | null;
  // sent | delivered | read | failed: the latest status Meta gave for it
  deliveryStatus?: string | null;
  // The message's text (only with LOG_CUSTOMER_DATA)
  content?: string | null;
  // What was sent to the other side (sanitized): the payload sent to Meta, or the webhook Meta sent us
  request?: unknown;
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
  // Sequential number of the entry (set when it is written; logFile.ts)
  logId: number | null;
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
  // WhatsApp's message id (wamid) itself: only with LOG_CUSTOMER_DATA
  waMessageId: string | null;
  // Its one-way reference (waRef): always, so entries match whichever way they were written
  waMessageRef: string | null;
  conversationId: string | null;
  messageSent: 0 | 1 | null;
  customerReceived: 0 | 1 | null;
  deliveryStatus: string | null;
  content: string | null;
  // Text (sent, open…) or a number (an HTTP status)
  previousStatus: string | number | null;
  newStatus: string | number | null;
  action: string;
  reason: string;
  outcome: string;
  source: string | null;
  request: unknown;
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

// --- The message being sent: Meta API calls made inside withMessageTrace name it, so a send's entries (upload,
// Meta's answer, a database error) all carry the message's own ids ---

type MessageTrace = { messageId: string; conversationId?: string | null };
const messageTrace = new AsyncLocalStorage<MessageTrace>();

export function withMessageTrace<T>(trace: MessageTrace, fn: () => T): T {
  return messageTrace.run(trace, fn);
}

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
// Limits for whole payloads (a webhook, a send to Meta): deep enough for Meta's nesting and a full message text
export type SanitizeLimits = { maxString: number; maxItems: number; maxDepth: number };
const ENTRY_LIMITS: SanitizeLimits = { maxString: MAX_STRING, maxItems: MAX_ITEMS, maxDepth: MAX_DEPTH };
export const PAYLOAD_LIMITS: SanitizeLimits = { maxString: 5000, maxItems: 100, maxDepth: 12 };
const customerData = () => env.logCustomerData;
const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|signature|credential|otp|hash/i;
// The customer's number, name and words, under the names Meta and this app give them
const CUSTOMER_KEY = /^(wa_?id|recipient(_?id)?|to|from|phone|phone_?number|display_phone_number|msisdn|contacts|profile|body|text|caption|content|sender_?name|filename|file_?name)$/i;
// WhatsApp's own ids: kept as a one-way reference (waRef), so entries about the same message still match
const WHATSAPP_ID_KEY = /^(wa_?message_?id|reaction_?wa_?message_?id|reply_?to_?wa_?message_?id|wamid|media_?id|phone_?number_?id|waba_?id)$/i;
const REDACTED = '[REDACTED]';
const PHONE = '[phone]';

// A one-way reference for one of WhatsApp's ids ("wa:" + 16 hex characters of its SHA-256): the same id always gives
// the same reference, but the id (a wamid holds the customer's number) can't be read back from it. The trace tool
// (npm run logs:trace) computes it from a wamid to find that message's entries.
export function waRef(id: string) {
  return id.startsWith('wa:') ? id : `wa:${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
}

function cleanString(s: string, max = MAX_STRING) {
  const redacted = s
    // A credential is long; ordinary words after "OAuth" (e.g. Meta's "Invalid OAuth access token") stay readable
    .replace(/\b(Bearer|OAuth|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, `$1 ${REDACTED}`)
    .replace(/\b((?:access_)?token|password|secret|signature|key)=([^&\s"']+)/gi, `$1=${REDACTED}`)
    // A live location link's token is the key to the customer's page (the link is in the message sent to them)
    .replace(/\/live\/[A-Za-z0-9_-]{16,}/g, '/live/[token]');
  return cut(customerData() ? redacted : maskCustomer(redacted), max);
}

// Without customer data: a wamid in text (e.g. in an error) becomes its reference, and phone numbers (10 to 15
// digits, optionally with +, not digits that are part of an id or a version) are masked
function maskCustomer(s: string) {
  return s.replace(/\bwamid\.[A-Za-z0-9+/=_-]{8,}/g, (id) => waRef(id)).replace(/(?<![\w.:/-])\+?\d{10,15}(?![\w])/g, PHONE);
}

function cut(redacted: string, max: number) {
  return redacted.length > max ? `${redacted.slice(0, max)}… (+${redacted.length - max} chars)` : redacted;
}

// Any text with the same redaction as logged values (tokens always; wamids and numbers too without customer data),
// not cut: for printing log lines, including older ones written under other rules
export const redactText = (text: string) => cleanString(String(text ?? ''), Number.MAX_SAFE_INTEGER);

// Text cut to fit a column of max characters, with the same redaction as every logged value. Never longer than max
// (counted as the database counts: whole characters, so an emoji is never split); a cut one ends in "…".
export function fitText(text: string, max = MAX_STRING) {
  const chars = Array.from(cleanString(String(text ?? ''), Number.MAX_SAFE_INTEGER));
  return chars.length <= max ? chars.join('') : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

// A copy that is safe to store and print: sensitive keys redacted, bearer tokens in text removed, long strings and
// arrays cut, nesting and cycles limited. Never throws.
export function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>(), limits: SanitizeLimits = ENTRY_LIMITS): unknown {
  try {
    if (value === null || value === undefined) return value ?? null;
    if (typeof value === 'string') return cleanString(value, limits.maxString);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    // Numeric ids (e.g. imported BigInt user ids) stay numbers when JSON can hold them exactly
    if (typeof value === 'bigint') return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value.toString();
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (Buffer.isBuffer(value)) return `[${value.length} bytes]`;
    if (value instanceof Error)
      return sanitize({ name: value.name, message: value.message, ...('code' in value ? { code: (value as any).code } : {}) }, depth, seen, limits);
    if (typeof value !== 'object') return String(value);
    if (seen.has(value)) return '[Circular]';
    if (depth >= limits.maxDepth) return '[Truncated]';
    seen.add(value);
    if (Array.isArray(value)) {
      const items = value.slice(0, limits.maxItems).map((v) => sanitize(v, depth + 1, seen, limits) ?? null);
      return value.length > limits.maxItems ? [...items, `… (+${value.length - limits.maxItems} more)`] : items;
    }
    const out: Record<string, unknown> = {};
    const withCustomer = customerData();
    for (const [key, v] of Object.entries(value)) {
      const clean = SENSITIVE_KEY.test(key) || (!withCustomer && CUSTOMER_KEY.test(key))
        ? v === null || v === undefined ? null : REDACTED
        : !withCustomer && WHATSAPP_ID_KEY.test(key) && (typeof v === 'string' || typeof v === 'number')
          ? waRef(String(v))
          : sanitize(v, depth + 1, seen, limits);
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
const refOrNull = (v: unknown) => (typeof v === 'string' && v ? waRef(v) : null);
const flagOrNull = (v: unknown) => (v === 1 || v === 0 ? v : null);
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
  'message.send_requested': { action: 'Send a message to the customer on WhatsApp', reason: 'A teammate pressed Send in the chat and the API received it' },
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
  'push.config_invalid': { action: 'Read the Firebase service account', reason: 'FIREBASE_SERVICE_ACCOUNT(_FILE) is set but unusable, so push notifications stay off' },
  'push.device_registered': { action: 'Register a phone for push notifications', reason: 'The mobile app signed in (or its token changed) and asked for notifications' },
  'push.device_unregistered': { action: 'Remove a phone from push notifications', reason: 'The mobile app signed out, or phone notifications were turned off' },
  'push.sent': { action: 'Send push notifications through Firebase', reason: 'A customer message, an assignment or an @mention for people with the app on their phone' },
  'push.send_failed': { action: 'Send one push notification through Firebase', reason: 'Firebase refused the notification for one phone (its code and a redacted message are logged)' },
  'push.failed': { action: 'Send push notifications through Firebase', reason: 'Looking up the phones or reaching Firebase failed' },
  'webhook.received': { action: "Process one of Meta's webhooks", reason: 'Meta called the webhook (messages, statuses, calls or other updates)' },
  'webhook.invalid_signature': { action: "Check a webhook's signature", reason: "A webhook's signature didn't match the app secret, so it was rejected" },
  'webhook.unknown_number': { action: "Process one of Meta's webhooks", reason: 'The webhook was for a WhatsApp number not connected to any workspace' },
  'webhook.message_failed': { action: 'Save an incoming WhatsApp message', reason: 'Saving one message of a webhook threw an error (the rest continued)' },
  'webhook.status_failed': { action: "Update a sent message's delivery status", reason: 'Applying one status of a webhook threw an error (the rest continued)' },
  'webhook.failed': { action: "Process one of Meta's webhooks", reason: 'Processing the webhook threw an error' },
  'webhook.reaction': { action: "Apply a customer's emoji reaction", reason: 'A customer reacted to (or un-reacted) one of the messages' },
  'webhook.reaction_unmatched': { action: "Apply a customer's emoji reaction", reason: "A customer reacted to a message this workspace doesn't have" },
  'webhook.notice': { action: "Process one of Meta's webhooks", reason: "Meta sent a notice that isn't a customer's message (not saved)" },
  'client.send_started': { action: 'Send a reply from the inbox (browser)', reason: 'A teammate pressed Send; the browser is sending it to the API' },
  'client.send_succeeded': { action: 'Send a reply from the inbox (browser)', reason: "The API answered the browser's send with the saved message" },
  'client.send_failed': { action: 'Send a reply from the inbox (browser)', reason: "The browser's send failed: refused by the API, no answer, or WhatsApp refused it" },
  'client.api_error': { action: 'Call the API from the web app', reason: 'A change made in the web app failed (the API refused it or could not be reached)' },
  'client.error': { action: 'Run the web app', reason: 'An error nobody caught happened in the browser' },
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
  const trace = messageTrace.getStore();
  const data = input.data === undefined ? null : sanitize(input.data);
  // Whole payloads (Meta's request and answer, a webhook): deeper and longer than other values, secrets redacted
  const payload = (v: unknown) => (v === undefined || v === null ? null : sanitize(v, 0, new WeakSet(), PAYLOAD_LIMITS));
  const response = payload(input.response);
  const info = eventInfo(String(input.event));
  return {
    logId: null,
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
    messageId: idOrNull(input.messageId ?? trace?.messageId),
    waMessageId: customerData() ? idOrNull(input.waMessageId) : null,
    waMessageRef: refOrNull(input.waMessageId),
    conversationId: idOrNull(input.conversationId ?? trace?.conversationId),
    messageSent: flagOrNull(input.messageSent),
    customerReceived: flagOrNull(input.customerReceived),
    deliveryStatus: input.deliveryStatus ? String(input.deliveryStatus).slice(0, 30) : null,
    content: customerData() && input.content ? cleanString(String(input.content), PAYLOAD_LIMITS.maxString) : null,
    previousStatus: statusOrNull(input.previousStatus),
    newStatus: statusOrNull(input.newStatus ?? input.status),
    action: cleanString(input.action ?? info?.action ?? input.event, 200),
    reason: cleanString(input.reason ?? info?.reason ?? 'Not described', 300),
    outcome: (input.outcome ?? OUTCOME_OF[input.level] ?? 'unknown').slice(0, 30),
    source: input.source ?? null,
    request: payload(input.request),
    response,
    errorDetails: input.errorDetails ? fitText(input.errorDetails, MAX_MESSAGE) : null,
    data: data && typeof data === 'object' && Object.keys(data).length ? data : null,
    at: new Date(),
  };
}

// The traceable fields not in LogEntry's own columns: kept in its data in the database (no schema change)
const EXTRA_FIELDS = [
  'logId', 'action', 'reason', 'outcome', 'source', 'direction', 'previousStatus', 'newStatus', 'messageId', 'waMessageId', 'waMessageRef',
  'conversationId', 'messageSent', 'customerReceived', 'deliveryStatus', 'content', 'request', 'response', 'errorDetails',
] as const;
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
    record.logId = nextLogId();
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
    record.logId = nextLogId();
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

// The error in words for errorDetails: its message, Meta's details when it gave some, and the network's own error
// under it (fetch's "fetch failed" says nothing; its cause, e.g. ECONNRESET, does)
export function errorDetailsOf(err: unknown): string | null {
  if (err === undefined || err === null) return null;
  const e = err as any;
  const message = typeof e?.message === 'string' ? e.message : String(err);
  const withDetails = typeof e?.details === 'string' && e.details && e.details !== message ? `${message}: ${e.details}` : message;
  const cause = e?.cause;
  const causeText = cause ? [cause.code, cause.message].filter((v) => typeof v === 'string' && v).join(' ') : '';
  return causeText && !withDetails.includes(causeText) ? `${withDetails} (${causeText})` : withDetails;
}

// Network errors that happen before a request reaches Meta: the message certainly wasn't sent. Any other network
// error (e.g. the connection reset after sending) leaves it unknown.
const NOT_SENT_NETWORK = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'CERT_HAS_EXPIRED', 'UND_ERR_CONNECT_TIMEOUT']);

export type MetaFailure = {
  // Why, in words, from facts only: Meta's answer (and what Meta documents its code to mean), or what happened instead
  reason: string;
  // refused (Meta answered with an error) | timeout | unreachable | unclear (an answer that can't be read) | failed
  outcome: string;
  // 0 the message certainly didn't go out; null it may have (a timeout, a 5xx, a dropped connection)
  sent: 0 | null;
  errorCode: string | number | null;
  response: Record<string, unknown> | null;
};

// Explains a failed call to Meta (a send, an upload). Works from the error's own fields (GraphApiError,
// MetaTimeoutError and MetaResponseError in whatsapp.ts, or fetch's network error), never from guesses.
export function describeMetaFailure(err: unknown): MetaFailure {
  const e = err as any;
  const message = typeof e?.message === 'string' ? e.message : String(err);
  if (e?.name === 'MetaTimeoutError')
    return {
      reason: `${message}. Whether Meta accepted it is unknown: if it did, its delivery status will still arrive by webhook`,
      outcome: 'timeout',
      sent: null,
      errorCode: 'META_TIMEOUT',
      response: { ok: false, timeout: true, timeoutMs: e.timeoutMs ?? null },
    };
  if (e?.name === 'MetaResponseError')
    return {
      reason: `${message}. Whether Meta sent it is unknown`,
      outcome: 'unclear',
      sent: null,
      errorCode: e.status ?? null,
      response: { ok: false, httpStatus: e.status ?? null, contentType: e.contentType ?? null, bytes: e.bytes ?? null },
    };
  if (e?.name === 'GraphApiError') {
    const code = e.code ?? null;
    const known = explainMetaError(code);
    const meta = [`HTTP ${e.status}`, code !== null ? `code ${code}${e.subcode !== null && e.subcode !== undefined ? `/${e.subcode}` : ''}` : 'no error code'].join(', ');
    const said = `${message}${e.details && e.details !== message ? `: ${e.details}` : ''}`;
    const meaning = known
      ? `. Meta documents code ${code} as: ${known}`
      : code !== null
        ? `. Code ${code} has no documented meaning in this app's list; Meta's own words are above`
        : '';
    // A 5xx is Meta failing on its side: whether the message went out isn't certain
    const serverSide = Number(e.status) >= 500;
    return {
      reason: `Meta ${serverSide ? 'failed' : 'refused it'} (${meta}): "${said}"${meaning}${serverSide ? '. Whether it was sent is unknown' : ''}`,
      outcome: serverSide ? 'unclear' : 'refused',
      sent: serverSide ? null : 0,
      errorCode: code ?? e.status ?? null,
      response: { ok: false, httpStatus: e.status ?? null, code, subcode: e.subcode ?? null, fbtraceId: e.fbtraceId ?? null, ...(e.body ? { body: e.body } : {}) },
    };
  }
  const cause = e?.cause;
  if (cause && (typeof cause.code === 'string' || message === 'fetch failed')) {
    const certain = typeof cause.code === 'string' && NOT_SENT_NETWORK.has(cause.code);
    return {
      reason: `Meta couldn't be reached: ${[cause.code, cause.message].filter(Boolean).join(' ') || message}${certain ? ' (the request never got to Meta, so it was not sent)' : '. Whether Meta got it is unknown'}`,
      outcome: 'unreachable',
      sent: certain ? 0 : null,
      errorCode: typeof cause.code === 'string' ? cause.code : null,
      response: { ok: false, network: true },
    };
  }
  return { reason: `The call to Meta failed without an answer from Meta: ${message}. Whether it was sent is unknown`, outcome: 'failed', sent: null, errorCode: errorCodeOf(err), response: null };
}

// Outgoing messages: Meta's answer to the send. Accepted: messageSent 1, deliveryStatus "sent", customerReceived
// null (only a delivered/read webhook confirms the customer got it). Refused: messageSent 0, customerReceived 0, and
// Meta's code, details and documented meaning. No clear answer (timeout, 5xx, dropped connection): both null, and
// the entry says it is unknown.
export function logMessageSend(p: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  type: string;
  userId?: string | null;
  automation?: string;
  error?: unknown;
  // WhatsApp's id for the message (when it accepted it); logged as its waRef
  waMessageId?: string | null;
  durationMs?: number | null;
  // The text sent (or the caption, or the template's text): logged with LOG_CUSTOMER_DATA; null for a secret (a
  // one-time code)
  content?: string | null;
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
    content: p.content,
    data: { type: p.type, ...(p.automation ? { automation: p.automation } : {}) },
  };
  if (p.error === undefined)
    return logEvent({
      ...common,
      level: 'SUCCESS',
      event: 'message.sent',
      message: `Sent a message (${p.type}): Meta accepted it; delivery to the customer is not confirmed until Meta's webhook reports it`,
      outcome: 'sent',
      newStatus: 'sent',
      messageSent: 1,
      customerReceived: null,
      deliveryStatus: 'sent',
      waMessageId: p.waMessageId,
      response: { ok: true, waMessageId: p.waMessageId ?? null },
    });
  const f = describeMetaFailure(p.error);
  return logEvent({
    ...common,
    level: 'ERROR',
    event: 'message.send_failed',
    message: `Message (${p.type}) ${f.sent === 0 ? 'not sent' : 'may not have been sent'}: ${f.reason}`,
    outcome: f.outcome,
    // The app marks the message failed either way (the agent sees it and can send it again)
    newStatus: 'failed',
    messageSent: f.sent,
    customerReceived: f.sent,
    deliveryStatus: f.sent === 0 ? 'failed' : null,
    errorCode: f.errorCode,
    errorDetails: errorDetailsOf(p.error),
    response: f.response,
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
