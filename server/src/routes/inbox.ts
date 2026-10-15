import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { env } from '../env.js';
import { sweepPresence } from '../presence.js';
import { wakeSnoozedConversations } from '../services/conversationStatus.js';
import { sendAssignmentReminders } from '../services/assignmentReminders.js';
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
  res.json(await openConversation(req.auth!.workspaceId, req.params.id, req.auth!.userId));
});

inboxRouter.post('/conversations/:id/messages', async (req, res) => {
  res.json(await sendMessage(req.auth!.workspaceId, req.params.id, req.body, req.auth!.userId));
});

// Start a chat with a new number (first message must be a template)
inboxRouter.post('/contacts', async (req, res) => {
  res.json(await startConversation(req.auth!.workspaceId, { waId: String(req.body?.waId ?? ''), name: req.body?.name }, req.auth!.userId));
});

// Dev only: fake an incoming customer message without Meta
if (!env.isProd) {
  inboxRouter.post('/dev/simulate-incoming', async (req, res) => {
    await simulateIncoming(req.auth!.workspaceId, req.body);
    res.json({ ok: true });
  });
  // Dev only: run one reminder check for your own workspace now instead of waiting for the schedule.
  // body.now (ISO time, optional): check as if it were that time, e.g. 6 minutes ahead (tests)
  inboxRouter.post('/dev/assignment-reminders', async (req, res) => {
    const at = req.body?.now ? new Date(String(req.body.now)) : new Date();
    res.json({ reminded: await sendAssignmentReminders(Number.isNaN(at.getTime()) ? new Date() : at, undefined, req.auth!.workspaceId) });
  });
  // Dev only: wake every snoozed chat whose time has come, now instead of within 30 seconds
  inboxRouter.post('/dev/wake-snoozed', async (_req, res) => {
    res.json({ woke: await wakeSnoozedConversations() });
  });
  // Dev only: mark everyone idle for longer than idleMs (default: the configured away time) as Away now
  inboxRouter.post('/dev/presence-sweep', (req, res) => {
    const idle = Number(req.body?.idleMs);
    res.json({ changed: sweepPresence(Date.now(), Number.isFinite(idle) && idle >= 0 ? idle : undefined) });
  });
}
