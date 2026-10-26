import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { AppError } from '../services/errors.js';
import { type LogInput, logEvent } from '../services/logging.js';

// What the web app reports about itself (POST /client-log, signed in only): each step of sending a reply from the
// inbox (started, succeeded, failed with the actual reason), API calls that failed, and errors nobody caught in the
// browser. A send's events carry the id the browser also sent as X-Request-Id on the send itself, so in the logs the
// browser's steps, the API's handling, the call to Meta and the saved message all share one requestId. When the
// send never reached the API (offline, the server restarting), the browser keeps the events and reports them later.
export const clientLogRouter = Router();
clientLogRouter.use(requireAuth);

const EVENTS = new Set(['send_started', 'send_succeeded', 'send_failed', 'api_error', 'error']);
const MAX_EVENTS = 20;
const text = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const id = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(v) ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

// The body's events as log entries (throws a 400 for a body that isn't a list of known events)
export function clientEvents(body: unknown, auth: { userId: string; workspaceId: string }): LogInput[] {
  const events = (body as any)?.events;
  if (!Array.isArray(events) || !events.length) throw new AppError('Expected { events: [...] }', 400, 'BAD_USER_INPUT');
  if (events.length > MAX_EVENTS) throw new AppError(`At most ${MAX_EVENTS} events at a time`, 400, 'BAD_USER_INPUT');
  return events.map((e: any): LogInput => {
    const name = typeof e?.event === 'string' && EVENTS.has(e.event) ? e.event : null;
    if (!name) throw new AppError(`Unknown client event "${String(e?.event).slice(0, 40)}"`, 400, 'BAD_USER_INPUT');
    const error = e.error && typeof e.error === 'object' ? e.error : null;
    // network: never reached the API; timeout: no answer in time (it may still have been sent); api: the API refused
    // it; whatsapp: saved but WhatsApp refused it; ui: the browser itself failed
    const kind = text(error?.kind, 20);
    const failed = name === 'send_failed' || name === 'api_error' || name === 'error';
    const status = text(e.status, 20);
    return {
      level: failed ? (kind === 'network' || kind === 'timeout' ? 'WARNING' : 'ERROR') : 'SUCCESS',
      category: 'client',
      event: `client.${name}`,
      message: clientMessage(name, { status, error: text(error?.message, 1000), kind, durationMs: num(e.durationMs) }),
      direction: 'in',
      outcome: name === 'send_started' ? 'sending' : name === 'send_succeeded' ? 'sent' : kind === 'timeout' ? 'unknown' : 'failed',
      requestId: id(e.requestId),
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      conversationId: id(e.conversationId),
      messageId: id(e.messageId),
      newStatus: status,
      deliveryStatus: name.startsWith('send_') ? status : null,
      durationMs: num(e.durationMs),
      content: text(e.content, 5000),
      errorCode: text(error?.code, 50),
      errorDetails: text(error?.message, 1000),
      data: {
        clientAt: text(e.at, 40),
        page: text(e.page, 200),
        operation: text(e.operation, 100),
        ...(kind ? { errorKind: kind } : {}),
        ...(e.httpStatus !== undefined ? { httpStatus: num(e.httpStatus) } : {}),
        ...(e.replyToId ? { replyToId: id(e.replyToId) } : {}),
        ...(e.delayedMs !== undefined ? { reportedLateMs: num(e.delayedMs) } : {}),
      },
    };
  });
}

function clientMessage(name: string, p: { status: string | null; error: string | null; kind: string | null; durationMs: number | null }) {
  const took = p.durationMs !== null ? ` after ${(p.durationMs / 1000).toFixed(1)} s` : '';
  if (name === 'send_started') return 'Browser: Send pressed, sending the reply to the API';
  if (name === 'send_succeeded') return `Browser: the API saved the reply (status "${p.status ?? '?'}")${took}`;
  if (name === 'send_failed')
    return p.kind === 'whatsapp'
      ? `Browser: the reply was saved but WhatsApp refused it${took}: ${p.error ?? 'no reason given'}`
      : p.kind === 'timeout'
        ? `Browser: no answer from the API${took}; the reply may or may not have been sent: ${p.error ?? ''}`.trim()
        : p.kind === 'network'
          ? `Browser: the reply never reached the API${took}: ${p.error ?? 'network error'}`
          : `Browser: the reply was not sent${took}: ${p.error ?? 'no reason given'}`;
  if (name === 'api_error') return `Browser: an API call failed${took}: ${p.error ?? 'no reason given'}`;
  return `Browser error: ${p.error ?? 'unknown'}`;
}

clientLogRouter.post('/', (req, res) => {
  const entries = clientEvents(req.body, req.auth!);
  for (const e of entries) void logEvent(e);
  res.json({ ok: true, logged: entries.length });
});
