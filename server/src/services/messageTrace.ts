// Reading the log files back (read-only; nothing is ever changed or deleted): one outgoing WhatsApp message followed
// end to end (the send, Meta's answer, each delivery status), and an audit of what the files can and can't show.
// Reads both formats: JSON lines (logs/YYYY-MM-DD.log) and the older text lines (logs/app-YYYY-MM-DD.log). Entries
// are matched by our message id and by waRef (computed from a raw wamid when that's what an entry holds), so entries
// written with or without LOG_CUSTOMER_DATA match. Anything printed goes through redactText.
import fs from 'node:fs';
import path from 'node:path';
import { LOG_FILE_PATTERN } from './logFile.js';
import { redactText, waRef } from './logging.js';

export type TraceEntry = {
  file: string;
  line: number;
  format: 'json' | 'text';
  logId: number | null;
  timestamp: string;
  level: string;
  event: string;
  message: string;
  messageId: string | null;
  waMessageRef: string | null;
  conversationId: string | null;
  requestId: string | null;
  direction: string | null;
  newStatus: string | null;
  deliveryStatus: string | null;
  messageSent: 0 | 1 | null;
  customerReceived: 0 | 1 | null;
  errorCode: string | number | null;
  errorDetails: string | null;
  outcome: string | null;
  durationMs: number | null;
  // Written with messageSent / customerReceived / deliveryStatus (entries from before them don't have these)
  tracked: boolean;
};

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const flag = (v: unknown) => (v === 1 || v === 0 ? v : null);
const ref = (v: unknown) => (typeof v === 'string' && v ? waRef(v) : null);

// "2026-10-26 12:59:21.592 +04:00 SUCCESS message.sent Sent a message (template) | req=… 1292ms data={…}"
const TEXT_LINE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{2}:\d{2}) (SUCCESS|WARNING|ERROR) (\S+) (.*)$/;

// One line of either format as a TraceEntry (null: blank or unreadable)
export function parseLogLine(text: string, file = '', line = 0): TraceEntry | null {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith('{')) {
    let j: any;
    try {
      j = JSON.parse(t);
    } catch {
      return null;
    }
    const d = j.data && typeof j.data === 'object' ? j.data : {};
    return {
      file,
      line,
      format: 'json',
      logId: typeof j.logId === 'number' ? j.logId : null,
      timestamp: String(j.timestamp ?? ''),
      level: String(j.level ?? ''),
      event: String(j.event ?? ''),
      message: String(j.message ?? ''),
      messageId: str(j.messageId) ?? str(d.messageId),
      // Newer entries carry the reference; entries written before it carry the wamid itself
      waMessageRef: str(j.waMessageRef) ?? ref(j.waMessageId) ?? ref(d.waMessageId),
      conversationId: str(j.conversationId) ?? str(d.conversationId),
      requestId: str(j.requestId),
      direction: str(j.direction),
      newStatus: j.newStatus === null || j.newStatus === undefined ? null : String(j.newStatus),
      deliveryStatus: str(j.deliveryStatus),
      messageSent: flag(j.messageSent),
      customerReceived: flag(j.customerReceived),
      errorCode: j.errorCode ?? null,
      errorDetails: str(j.errorDetails),
      outcome: str(j.outcome),
      durationMs: typeof j.durationMs === 'number' ? j.durationMs : null,
      tracked: 'messageSent' in j,
    };
  }
  const m = TEXT_LINE.exec(t);
  if (!m) return null;
  const [, stamp, level, event, rest] = m;
  const bar = rest.indexOf(' | ');
  const message = bar === -1 ? rest : rest.slice(0, bar);
  const meta = bar === -1 ? '' : rest.slice(bar + 3);
  let d: any = {};
  const at = meta.indexOf('data=');
  if (at !== -1)
    try {
      d = JSON.parse(meta.slice(at + 5));
    } catch {
      d = {};
    }
  const ms = /(?:^| )(\d+)ms(?: |$)/.exec(meta);
  const code = /(?:^| )code=(\S+)/.exec(meta);
  const req = /(?:^| )req=(\S+)/.exec(meta);
  return {
    file,
    line,
    format: 'text',
    logId: null,
    timestamp: stamp,
    level,
    event,
    message,
    messageId: str(d.messageId),
    waMessageRef: ref(d.waMessageId),
    conversationId: str(d.conversationId),
    requestId: req ? req[1] : null,
    direction: null,
    newStatus: str(d.to) ?? (event === 'message.sent' ? 'sent' : null),
    deliveryStatus: null,
    messageSent: null,
    customerReceived: null,
    errorCode: code ? code[1] : null,
    errorDetails: null,
    outcome: null,
    durationMs: ms ? Number(ms[1]) : null,
    tracked: false,
  };
}

// The log files of a folder (both formats), oldest first; days: only the last n days' files
export function logFiles(dir: string, days?: number) {
  let files: { name: string; day: string }[] = [];
  try {
    files = fs
      .readdirSync(dir)
      .map((name) => ({ name, m: LOG_FILE_PATTERN.exec(name) }))
      .filter((f) => f.m)
      .map((f) => ({ name: f.name, day: f.m![1] }));
  } catch {
    return [];
  }
  files.sort((a, b) => a.day.localeCompare(b.day) || (a.name.startsWith('app-') ? -1 : 1));
  if (days) {
    const keep = [...new Set(files.map((f) => f.day))].slice(-days);
    files = files.filter((f) => keep.includes(f.day));
  }
  return files.map((f) => path.join(dir, f.name));
}

export type ReadResult = { entries: TraceEntry[]; lines: number; unreadable: number; byFormat: Record<string, number>; rawText: string[] };

export function readLogs(files: string[]): ReadResult {
  const out: ReadResult = { entries: [], lines: 0, unreadable: 0, byFormat: { json: 0, text: 0 }, rawText: [] };
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    text.split('\n').forEach((l, i) => {
      if (!l.trim()) return;
      out.lines++;
      out.rawText.push(l);
      const e = parseLogLine(l, path.basename(file), i + 1);
      if (!e) return void out.unreadable++;
      out.byFormat[e.format]++;
      out.entries.push(e);
    });
  }
  return out;
}

// --- One message, end to end ---

const SEND_EVENTS = new Set(['message.sent', 'message.send_failed']);
const STATUS_EVENTS = new Set(['message.status', 'message.status_stale', 'message.status_unmatched']);
const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };

export type MessageTrace = {
  messageId: string | null;
  waMessageRef: string | null;
  conversationId: string | null;
  entries: TraceEntry[];
  // accepted (Meta took it) | refused | unknown (timeout, unclear answer) | not logged
  send: 'accepted' | 'refused' | 'unknown' | 'not logged';
  // The latest delivery status Meta reported (none: no status webhook in these logs)
  deliveryStatus: string | null;
  // 1 delivered/read, 0 failed or refused, null not confirmed
  customerReceived: 0 | 1 | null;
  // Meta's words for a failure, as logged (never filled in when the logs have none)
  failureReasons: string[];
  // What the logs can't show for this message
  gaps: string[];
};

// Groups the entries into outgoing messages: by our message id, and by WhatsApp's reference (statuses for a message
// whose send isn't in these files still form a trace of their own)
export function buildTraces(entries: TraceEntry[]): MessageTrace[] {
  const refToId = new Map<string, string>();
  for (const e of entries) if (e.messageId && e.waMessageRef) refToId.set(e.waMessageRef, e.messageId);
  // Older entries of Meta's answer (whatsapp.send) name no message: matched by request id, only when exactly one
  // message was sent in that request (otherwise left out rather than guessed)
  const sendsByRequest = new Map<string, Set<string>>();
  for (const e of entries)
    if (SEND_EVENTS.has(e.event) && e.requestId && e.messageId) {
      if (!sendsByRequest.has(e.requestId)) sendsByRequest.set(e.requestId, new Set());
      sendsByRequest.get(e.requestId)!.add(e.messageId);
    }
  const byRequest = (e: TraceEntry) => {
    const ids = e.event === 'whatsapp.send' && e.requestId ? sendsByRequest.get(e.requestId) : undefined;
    return ids?.size === 1 ? [...ids][0] : undefined;
  };
  const groups = new Map<string, TraceEntry[]>();
  const keyOf = (e: TraceEntry) => {
    const id = e.messageId ?? (e.waMessageRef ? refToId.get(e.waMessageRef) : undefined) ?? byRequest(e);
    return id ? `id:${id}` : e.waMessageRef ? `ref:${e.waMessageRef}` : null;
  };
  // Sends and statuses make the traces; Meta's answers (whatsapp.send) only join one (a reaction's send isn't a message)
  for (const e of entries) {
    if (!SEND_EVENTS.has(e.event) && !STATUS_EVENTS.has(e.event)) continue;
    const key = keyOf(e);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }
  for (const e of entries) {
    if (e.event !== 'whatsapp.send') continue;
    const key = keyOf(e);
    if (key && groups.has(key)) groups.get(key)!.push(e);
  }
  return [...groups.values()].map(summarize);
}

function summarize(list: TraceEntry[]): MessageTrace {
  const entries = [...list].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || (a.logId ?? 0) - (b.logId ?? 0));
  const sendEntry = entries.find((e) => SEND_EVENTS.has(e.event));
  const failedSend = sendEntry?.event === 'message.send_failed';
  // A failed send: newer entries say whether it certainly didn't go out (messageSent 0) or it's unknown (null).
  // Older ones don't: only a numeric Meta error code shows Meta refused it; anything else stays unknown.
  const send: MessageTrace['send'] = !sendEntry
    ? 'not logged'
    : !failedSend
      ? 'accepted'
      : sendEntry.tracked
        ? sendEntry.messageSent === 0
          ? 'refused'
          : 'unknown'
        : /^\d+$/.test(String(sendEntry.errorCode ?? ''))
          ? 'refused'
          : 'unknown';
  let deliveryStatus: string | null = null;
  for (const e of entries) {
    if (!STATUS_EVENTS.has(e.event) || e.event === 'message.status_stale') continue;
    const s = e.deliveryStatus ?? e.newStatus;
    if (s && (RANK[s] ?? 0) >= (RANK[deliveryStatus ?? ''] ?? 0)) deliveryStatus = s;
  }
  const customerReceived: 0 | 1 | null =
    deliveryStatus === 'delivered' || deliveryStatus === 'read' ? 1 : deliveryStatus === 'failed' || send === 'refused' ? 0 : null;
  const failureReasons = entries
    .filter((e) => e.event === 'message.send_failed' || ((e.deliveryStatus ?? e.newStatus) === 'failed' && STATUS_EVENTS.has(e.event)))
    .map((e) => e.errorDetails ?? e.message);
  const gaps: string[] = [];
  const first = entries[0];
  if (send === 'not logged') gaps.push('The send itself is not in these log files (sent before them, or from the phone)');
  if (send === 'accepted' && !deliveryStatus) gaps.push('Meta accepted it, but no delivery status webhook is in these logs: delivery is not confirmed');
  if (send === 'accepted' && deliveryStatus === 'sent') gaps.push('Only "sent" was reported: delivery to the customer is not confirmed');
  if (send === 'unknown') gaps.push(`No clear answer from Meta (${sendEntry?.outcome ?? 'unknown'}): whether it was sent is unknown${deliveryStatus ? '' : ', and no status webhook arrived'}`);
  if (failureReasons.length && failureReasons.every((r) => !r || /no error code or reason|no reason given/i.test(r)))
    gaps.push('Failed, and Meta gave no reason');
  if (first?.format === 'text' || entries.some((e) => e.format === 'json' && e.logId === null))
    gaps.push('Some entries are in the older format (no logId, no delivery fields)');
  return {
    messageId: entries.find((e) => e.messageId)?.messageId ?? null,
    waMessageRef: entries.find((e) => e.waMessageRef)?.waMessageRef ?? null,
    conversationId: entries.find((e) => e.conversationId)?.conversationId ?? null,
    entries,
    send,
    deliveryStatus,
    customerReceived,
    failureReasons,
    gaps,
  };
}

// The trace for a message id, a wamid or a waRef (null: not in these entries)
export function findTrace(entries: TraceEntry[], id: string): MessageTrace | null {
  const wanted = id.startsWith('wamid.') ? waRef(id) : id;
  return buildTraces(entries).find((t) => t.messageId === wanted || t.waMessageRef === wanted) ?? null;
}

// --- Audit ---

export type Audit = {
  files: string[];
  lines: number;
  unreadable: number;
  byFormat: Record<string, number>;
  messages: number;
  bySend: Record<string, number>;
  byDeliveryStatus: Record<string, number>;
  confirmedReceived: number;
  confirmedFailed: number;
  unconfirmed: number;
  failuresWithoutReason: number;
  // Lines that hold customer data or secrets in clear (older entries, written before the redaction)
  privacy: { rawWamid: number; phoneNumbers: number; bearerTokens: number; messageContent: number };
  gaps: Record<string, number>;
};

export function audit(files: string[]): Audit {
  const read = readLogs(files);
  const traces = buildTraces(read.entries);
  const count = (list: (string | null)[]) => list.reduce<Record<string, number>>((acc, k) => ((acc[k ?? 'none'] = (acc[k ?? 'none'] ?? 0) + 1), acc), {});
  const gaps = count(traces.flatMap((t) => t.gaps));
  const privacy = { rawWamid: 0, phoneNumbers: 0, bearerTokens: 0, messageContent: 0 };
  for (const l of read.rawText) {
    if (/\bwamid\.[A-Za-z0-9+/=_-]{8,}/.test(l)) privacy.rawWamid++;
    if (/(?<![\w.:/-])\+?\d{10,15}(?![\w])/.test(l.replace(/"(timestamp|metaTimestamp|logId|durationMs|bytes|msSinceCreated)":\d+/g, ''))) privacy.phoneNumbers++;
    if (/\b(Bearer|OAuth)\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{12,}/.test(l)) privacy.bearerTokens++;
    if (/"content":"/.test(l)) privacy.messageContent++;
  }
  return {
    files: files.map((f) => path.basename(f)),
    lines: read.lines,
    unreadable: read.unreadable,
    byFormat: read.byFormat,
    messages: traces.length,
    bySend: count(traces.map((t) => t.send)),
    byDeliveryStatus: count(traces.map((t) => t.deliveryStatus)),
    confirmedReceived: traces.filter((t) => t.customerReceived === 1).length,
    confirmedFailed: traces.filter((t) => t.customerReceived === 0).length,
    unconfirmed: traces.filter((t) => t.customerReceived === null).length,
    failuresWithoutReason: traces.filter((t) => t.failureReasons.length && t.failureReasons.every((r) => !r || /no error code or reason|no reason given/i.test(r))).length,
    privacy,
    gaps,
  };
}

// One entry as a printable line (redacted: older entries may hold a wamid or a number)
export function describeEntry(e: TraceEntry) {
  const parts = [
    e.timestamp,
    e.logId !== null ? `#${e.logId}` : '#-',
    e.level.padEnd(7),
    e.event,
    e.deliveryStatus ? `[${e.deliveryStatus}]` : e.newStatus ? `[${e.newStatus}]` : '',
    e.durationMs !== null ? `${e.durationMs}ms` : '',
    e.errorCode !== null ? `code=${e.errorCode}` : '',
    '—',
    e.message,
  ];
  return redactText(parts.filter(Boolean).join(' '));
}
