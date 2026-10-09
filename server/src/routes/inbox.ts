import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { env } from '../env.js';
import {
  listConversations,
  openConversation,
  sendMessage,
  simulateIncoming,
  startConversation,
} from '../services/inbox.js';

// REST version of the inbox API, kept for compatibility. The web app uses GraphQL (/graphql);
// both share the logic in services/inbox.ts.
export const inboxRouter = Router();
inboxRouter.use(requireAuth);

inboxRouter.get('/conversations', async (req, res) => {
  res.json(await listConversations(req.auth!.workspaceId));
});

inboxRouter.get('/conversations/:id/messages', async (req, res) => {
  res.json(await openConversation(req.auth!.workspaceId, req.params.id));
});

inboxRouter.post('/conversations/:id/messages', async (req, res) => {
  res.json(await sendMessage(req.auth!.workspaceId, req.params.id, req.body));
});

// Start a chat with a new number (first message must be a template)
inboxRouter.post('/contacts', async (req, res) => {
  res.json(await startConversation(req.auth!.workspaceId, { waId: String(req.body?.waId ?? ''), name: req.body?.name }));
});

// Dev only: fake an incoming customer message without Meta
if (!env.isProd) {
  inboxRouter.post('/dev/simulate-incoming', async (req, res) => {
    await simulateIncoming(req.auth!.workspaceId, req.body);
    res.json({ ok: true });
  });
}
