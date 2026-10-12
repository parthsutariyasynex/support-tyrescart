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

// Meta signs every webhook with the app secret (X-Hub-Signature-256). Without META_APP_SECRET, unsigned
// webhooks are accepted only outside production, so local testing still works.
export function validSignature(rawBody: Buffer | undefined, header: string | undefined, secret: string, isProd: boolean) {
  if (!secret) return !isProd;
  if (!rawBody || !header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return expected.length === header.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}

if (env.isProd && !env.metaAppSecret)
  console.error('[Webhook] META_APP_SECRET is not set: every webhook will be rejected until it is');

// Incoming messages + delivery/read statuses
webhookRouter.post('/', async (req, res) => {
  // Logs never include customer numbers, names or message text: only ids, types and statuses
  if (!validSignature((req as any).rawBody, req.header('x-hub-signature-256'), env.metaAppSecret, env.isProd)) {
    console.warn('[Webhook] Invalid signature, rejecting');
    return res.sendStatus(401);
  }
  res.sendStatus(200); // answer fast; Meta retries slow/failed webhooks

  try {
    for (const entry of req.body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        const phoneNumberId = value?.metadata?.phone_number_id;
        console.log('[Webhook] Event change:', { field: change.field, phoneNumberId, messagesCount: value?.messages?.length, statusesCount: value?.statuses?.length });
        if (!phoneNumberId) continue;
        const account = await prisma.whatsAppAccount.findUnique({ where: { phoneNumberId } });
        if (!account) {
          console.warn(`[Webhook] No WhatsAppAccount found for phoneNumberId: ${phoneNumberId}`);
          continue;
        }

        for (const msg of value.messages ?? []) {
          console.log('[Webhook] Incoming message:', { id: msg?.id, type: msg?.type });
          await saveIncoming(account.workspaceId, parseWebhookMessage(msg, value.contacts));
        }
        for (const status of value.statuses ?? []) {
          console.log('[Webhook] Status update:', {
            id: status?.id,
            status: status?.status,
            errors: status?.errors?.map((e: any) => ({ code: e.code, title: e.title })),
          });
          await applyStatus(account.workspaceId, status);
        }
      }
    }
  } catch (err) {
    console.error('[Webhook] Webhook processing failed', err);
  }
});
