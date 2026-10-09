import crypto from 'node:crypto';
import { Router } from 'express';
import { env } from '../env.js';
import { applyStatus, parseWebhookMessage, saveIncoming } from '../messages.js';
import { prisma } from '../prisma.js';

export const webhookRouter = Router();

// Meta calls this once when you register the webhook URL
webhookRouter.get('/', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === env.metaVerifyToken)
    return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
});

function validSignature(rawBody: Buffer | undefined, header: string | undefined) {
  if (!env.metaAppSecret) return !env.isProd; // allow unsigned only in dev
  if (!rawBody || !header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', env.metaAppSecret).update(rawBody).digest('hex');
  return expected.length === header.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}

// Incoming messages + delivery/read statuses
webhookRouter.post('/', async (req, res) => {
  if (!validSignature((req as any).rawBody, req.header('x-hub-signature-256'))) return res.sendStatus(401);
  res.sendStatus(200); // answer fast; Meta retries slow/failed webhooks

  try {
    for (const entry of req.body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        const phoneNumberId = value?.metadata?.phone_number_id;
        if (!phoneNumberId) continue;
        const account = await prisma.whatsAppAccount.findUnique({ where: { phoneNumberId } });
        if (!account) continue;

        for (const msg of value.messages ?? [])
          await saveIncoming(account.workspaceId, parseWebhookMessage(msg, value.contacts));
        for (const status of value.statuses ?? []) await applyStatus(account.workspaceId, status);
      }
    }
  } catch (err) {
    console.error('Webhook processing failed', err);
  }
});
