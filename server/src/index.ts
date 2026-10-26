import { STATUS_CODES, createServer } from 'node:http';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { env } from './env.js';
import { yoga } from './graphql/index.js';
import { initRealtime } from './realtime.js';
import { authRouter } from './routes/auth.js';
import { inboxRouter } from './routes/inbox.js';
import { meRouter } from './routes/me.js';
import { templatesRouter } from './routes/templates.js';
import { reportsRouter } from './routes/reports.js';
import { settingsRouter } from './routes/settings.js';
import { webhookRouter } from './routes/webhook.js';
import { liveRouter } from './routes/live.js';
import { clientLogRouter } from './routes/clientLog.js';
import { startAssignmentReminders } from './services/assignmentReminders.js';
import { startSnoozeWaker } from './services/conversationStatus.js';
import { startDeletedContactsPurge } from './services/deletedContacts.js';
import { startLogRetention } from './services/logRetention.js';
import { startLiveLocationSweeper } from './services/liveLocation.js';
import { AppError } from './services/errors.js';
import { installCrashLogger, logEvent, logEventSync, outcomeForStatus, requestIdFrom, runWithRequest } from './services/logging.js';

const app = express();
app.use(cors({ origin: env.webOrigin }));
// Every request gets an id (X-Request-Id, reused from a proxy when it sends one): each log entry it causes carries it
app.use((req, res, next) => {
  const requestId = requestIdFrom(req.header('x-request-id'));
  (req as any).requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  runWithRequest(requestId, next);
});
// Every HTTP request and its response (except /health): method, path (never the query string or body, and a live
// location link's token masked), status, response size and duration. Successful ones go to the day's log file only
// (there are many); refusals and errors to the database too. A request the client gave up on is logged as aborted.
// GraphQL operations and webhooks also log their own entries, with the same request id.
export const logPath = (originalUrl: string) => originalUrl.split('?')[0].replace(/^\/live\/[^/]+/, '/live/[token]');
app.use((req, res, next) => {
  const started = Date.now();
  const requestId = (req as any).requestId as string;
  const path = logPath(req.originalUrl);
  if (path === '/health') return next();
  // The error message the API answered with (its JSON "error"), so a refusal says why, not just its status code
  let answeredError: string | null = null;
  const json = res.json.bind(res);
  res.json = (body: any) => {
    if (res.statusCode >= 400 && body && typeof body === 'object' && typeof body.error === 'string') answeredError = body.error;
    return json(body);
  };
  let done = false;
  const log = (aborted: boolean) => {
    if (done) return;
    done = true;
    const level = aborted ? 'WARNING' : outcomeForStatus(res.statusCode);
    const bytes = Number(res.getHeader('content-length')) || null;
    void logEvent({
      level,
      category: 'http',
      event: aborted ? 'http.aborted' : 'http.request',
      message: aborted ? `${req.method} ${path}: the client closed the connection before the response` : `${req.method} ${path} → ${res.statusCode}`,
      direction: 'in',
      newStatus: aborted ? 'aborted' : res.statusCode,
      outcome: aborted ? 'aborted' : res.statusCode >= 500 ? 'failed' : res.statusCode >= 400 ? 'refused' : 'succeeded',
      reason: path.startsWith('/webhook')
        ? `Meta called the webhook (${req.method} ${path})`
        : path === '/graphql'
          ? 'The web app called the GraphQL API (the operation is logged separately, same request id)'
          : `A client called ${req.method} ${path}${req.auth ? '' : ' (not signed in)'}`,
      requestId,
      workspaceId: req.auth?.workspaceId,
      userId: req.auth?.userId,
      durationMs: Date.now() - started,
      errorDetails: aborted
        ? 'The client closed the connection before the response was sent'
        : res.statusCode >= 400
          ? (answeredError ?? `HTTP ${res.statusCode} ${STATUS_CODES[res.statusCode] ?? ''}`.trim())
          : null,
      response: aborted ? null : { status: res.statusCode, bytes, contentType: String(res.getHeader('content-type') ?? '').split(';')[0] || null, ...(answeredError ? { error: answeredError } : {}) },
      data: { method: req.method, path },
      fileOnly: level === 'SUCCESS',
    });
  };
  res.on('finish', () => log(false));
  res.on('close', () => log(!res.writableFinished));
  next();
});
// GraphQL parses its own body, so mount it before express.json
app.use(yoga.graphqlEndpoint, (req, res) => yoga(req, res, { req, res }));
// Keep the raw body so the webhook can verify Meta's signature
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => ((req as any).rawBody = buf) }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/auth', authRouter);
app.use('/webhook', webhookRouter);
app.use('/inbox', inboxRouter);
app.use('/me', meRouter);
app.use('/templates', templatesRouter);
app.use('/settings', settingsRouter);
app.use('/reports', reportsRouter);
// Live location links the customer opens (public; the token in the link is the key)
app.use('/live', liveRouter);
// What the web app reports about sending replies and its own errors (signed in only)
app.use('/client-log', clientLogRouter);

// Always answer with JSON, never Express's HTML error page (it leaks stack traces)
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too large (images up to 5 MB, voice messages up to 16 MB, documents up to 100 MB)' });
  console.error(err);
  const path = req.originalUrl.split('?')[0];
  void logEvent({
    level: 'ERROR',
    category: 'http',
    event: 'http.unhandled_error',
    message: `${req.method} ${path} failed: ${err?.message ?? String(err)}`,
    workspaceId: req.auth?.workspaceId,
    userId: req.auth?.userId,
    data: { method: req.method, path, error: err, stack: typeof err?.stack === 'string' ? err.stack.split('\n').slice(0, 6).join('\n') : undefined },
  });
  // The request id lets the team find this error in the logs
  res.status(500).json({ error: 'Something went wrong', requestId: (req as any).requestId });
});

const server = createServer(app);
initRealtime(server);
server.listen(env.port, () => {
  console.log(`API running on http://localhost:${env.port}`);
  void logEvent({
    level: 'SUCCESS',
    category: 'system',
    event: 'server.started',
    message: `API listening on port ${env.port}`,
    outcome: 'started',
    newStatus: 'running',
    data: { port: env.port, pid: process.pid, node: process.version, production: env.isProd, logDir: env.logDir },
  });
});
installCrashLogger();
const stopReminders = startAssignmentReminders();
const stopSnoozeWaker = startSnoozeWaker();
const stopPurge = startDeletedContactsPurge();
const stopLogRetention = startLogRetention();
const stopLiveSweeper = startLiveLocationSweeper();
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    logEventSync({ level: 'SUCCESS', category: 'system', event: 'server.stopping', message: `Received ${signal}: stopping the scheduled jobs`, reason: `The process received ${signal} (Ctrl+C, a restart or a deploy)`, outcome: 'stopping', previousStatus: 'running', newStatus: 'stopping', data: { signal, pid: process.pid, uptimeSeconds: Math.round(process.uptime()) } });
    stopReminders();
    stopSnoozeWaker();
    stopPurge();
    stopLogRetention();
    stopLiveSweeper();
  });
