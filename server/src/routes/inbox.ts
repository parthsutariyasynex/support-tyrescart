import express, { Router } from 'express';
import { requireAuth } from '../auth.js';
import { sendTemplateMessage } from '../services/templates.js';
import { readRemarkFile, uploadRemarkFile } from '../services/contacts.js';
import { withSender } from '../services/senders.js';
import { env } from '../env.js';
import { sweepPresence } from '../presence.js';
import { wakeSnoozedConversations } from '../services/conversationStatus.js';
import { sendAssignmentReminders } from '../services/assignmentReminders.js';
import {
  listConversations,
  openConversation,
  readMessageMedia,
  sendMediaMessage,
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

// Send an image: the body is the image itself (Content-Type image/jpeg or image/png, up to 5 MB); the optional
// caption is the `caption` query parameter (and `replyTo`, a message id, to send it as a reply)
inboxRouter.post(
  '/conversations/:id/images',
  express.raw({ type: () => true, limit: '5mb' }),
  async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : undefined;
    res.json(await sendMediaMessage('image', req.auth!.workspaceId, req.params.id, body, req.headers['content-type'], req.query.caption, null, req.auth!.userId, req.query.replyTo));
  },
);

// Send a document (PDF, Word, Excel, PowerPoint or text, up to 100 MB): the body is the file itself; `name` (its
// file name), `caption` and `replyTo` (a message id, to send it as a reply) are query parameters
inboxRouter.post(
  '/conversations/:id/documents',
  express.raw({ type: () => true, limit: '100mb' }),
  async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : undefined;
    res.json(await sendMediaMessage('document', req.auth!.workspaceId, req.params.id, body, req.headers['content-type'], req.query.caption, req.query.name, req.auth!.userId, req.query.replyTo));
  },
);

// Send a voice note recorded in the browser: the body is the recording (audio/ogg, audio/webm with Opus, or
// audio/mp4; up to 16 MB). WebM is repackaged to OGG/Opus so it shows as a voice note on WhatsApp.
inboxRouter.post(
  '/conversations/:id/voice',
  express.raw({ type: () => true, limit: '16mb' }),
  async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : undefined;
    res.json(await sendMediaMessage('voice', req.auth!.workspaceId, req.params.id, body, req.headers['content-type'], null, null, req.auth!.userId, req.query.replyTo));
  },
);

// An image or document message's stored copy (members of the workspace only). Documents download with their name.
// Send an approved template whose header is an image, video or document: the body is the file; `name`,
// `language` and `values` (JSON) are query parameters, `fileName` the document's name; confirmed=true and requestId
// as for sendTemplateMessage (sent only after the agent's "Yes, Send")
inboxRouter.post('/conversations/:id/template', express.raw({ type: () => true, limit: '100mb' }), async (req, res) => {
  const body = Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined;
  let values: unknown;
  try {
    values = typeof req.query.values === 'string' && req.query.values ? JSON.parse(req.query.values) : undefined;
  } catch {
    return res.status(400).json({ error: 'Invalid values' });
  }
  const sent = await sendTemplateMessage(
    req.auth!,
    { conversationId: req.params.id, name: req.query.name, language: req.query.language || undefined, values, confirmed: req.query.confirmed === 'true', requestId: req.query.requestId },
    { bytes: body, mime: req.headers['content-type'], name: typeof req.query.fileName === 'string' ? req.query.fileName : undefined },
  );
  res.json(await withSender(sent));
});

// A file for an internal note (Add note → 📎): the body is the file, ?name= its name. Returns its id, attached when the
// note is saved (addContactRemark files). Never sent to WhatsApp.
inboxRouter.post('/contacts/:id/remark-files', express.raw({ type: () => true, limit: '100mb' }), async (req, res) => {
  const body = Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined;
  res.json(await uploadRemarkFile(req.auth!, req.params.id, body, req.headers['content-type'], req.query.name));
});

// A note's file, for the team only (signed in, same workspace)
inboxRouter.get('/remark-files/:id', async (req, res) => {
  const { bytes, mime, name } = await readRemarkFile(req.auth!, req.params.id);
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(bytes);
});

inboxRouter.get('/messages/:id/media', async (req, res) => {
  const { bytes, mime, name } = await readMessageMedia(req.auth!.workspaceId, req.params.id);
  res.setHeader('Content-Type', mime);
  if (name) res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(bytes);
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
