import { createServer } from 'node:http';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { env } from './env.js';
import { yoga } from './graphql/index.js';
import { initRealtime } from './realtime.js';
import { authRouter } from './routes/auth.js';
import { inboxRouter } from './routes/inbox.js';
import { settingsRouter } from './routes/settings.js';
import { webhookRouter } from './routes/webhook.js';
import { AppError } from './services/errors.js';

const app = express();
app.use(cors({ origin: env.webOrigin }));
// GraphQL parses its own body, so mount it before express.json
app.use(yoga.graphqlEndpoint, (req, res) => yoga(req, res, { req, res }));
// Keep the raw body so the webhook can verify Meta's signature
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => ((req as any).rawBody = buf) }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/auth', authRouter);
app.use('/webhook', webhookRouter);
app.use('/inbox', inboxRouter);
app.use('/settings', settingsRouter);

// Always answer with JSON, never Express's HTML error page (it leaks stack traces)
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

const server = createServer(app);
initRealtime(server);
server.listen(env.port, () => console.log(`API running on http://localhost:${env.port}`));
