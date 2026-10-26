import { createServer } from 'node:http';
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
import { startAssignmentReminders } from './services/assignmentReminders.js';
import { startSnoozeWaker } from './services/conversationStatus.js';
import { startDeletedContactsPurge } from './services/deletedContacts.js';
import { startLogRetention } from './services/logRetention.js';
import { startLiveLocationSweeper } from './services/liveLocation.js';
import { AppError } from './services/errors.js';
import { logEvent, outcomeForStatus, requestIdFrom, runWithRequest } from './services/logging.js';

const app = express();
app.use(cors({ origin: env.webOrigin }));
// Every request gets an id (X-Request-Id, reused from a proxy when it sends one): each log entry it causes carries it
app.use((req, res, next) => {
  const requestId = requestIdFrom(req.header('x-request-id'));
  (req as any).requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  runWithRequest(requestId, next);
});
// HTTP outcomes: refusals and server errors always, and requests that change something (not GET) when they work.
// GraphQL is logged per operation and webhooks by their route, so neither is repeated here. The path only, never
// the query string or body.
app.use((req, res, next) => {
  const started = Date.now();
  const requestId = (req as any).requestId as string;
  res.on('finish', () => {
    const path = req.originalUrl.split('?')[0];
    if (path === '/health' || path.startsWith(yoga.graphqlEndpoint) || path.startsWith('/webhook')) return;
    const level = outcomeForStatus(res.statusCode);
    if (level === 'SUCCESS' && ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    void logEvent({
      level,
      category: 'http',
      event: 'http.request',
      message: `${req.method} ${path} → ${res.statusCode}`,
      requestId,
      workspaceId: req.auth?.workspaceId,
      userId: req.auth?.userId,
      durationMs: Date.now() - started,
      data: { method: req.method, path, status: res.statusCode },
    });
  });
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
server.listen(env.port, () => console.log(`API running on http://localhost:${env.port}`));
const stopReminders = startAssignmentReminders();
const stopSnoozeWaker = startSnoozeWaker();
const stopPurge = startDeletedContactsPurge();
const stopLogRetention = startLogRetention();
const stopLiveSweeper = startLiveLocationSweeper();
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    stopReminders();
    stopSnoozeWaker();
    stopPurge();
    stopLogRetention();
    stopLiveSweeper();
  });
