import crypto from 'node:crypto';
import { Router } from 'express';
import { env } from '../env.js';
import { applyStatus, parseWebhookMessage, saveIncoming } from '../messages.js';
import { applyCustomerReaction } from '../services/reactions.js';
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

// Diagnostics only - mirrors validSignature's own checks so a real rejection says *why* (missing secret, missing
// header/body, or an actual HMAC mismatch) instead of a bare "rejecting". Never includes the secret, the header's
// value, or the body's content - only booleans and a byte count, safe to log.
export function signatureFailureReason(rawBody: Buffer | undefined, header: string | undefined, secret: string, isProd: boolean): string {
  if (!secret) return isProd ? 'META_APP_SECRET is not configured' : 'ok without a secret outside production';
  if (!rawBody) return 'request had no body (rawBody capture missing or empty payload)';
  if (!header) return 'x-hub-signature-256 header missing';
  return 'signature does not match the computed HMAC (wrong/rotated secret, or the body was altered in transit)';
}

if (env.isProd && !env.metaAppSecret)
  console.error('[Webhook] META_APP_SECRET is not set: every webhook will be rejected until it is');

// Incoming messages + delivery/read statuses
webhookRouter.post('/', async (req, res) => {
  // Logs never include customer numbers, names or message text: only ids, types and statuses
  const rawBody = (req as any).rawBody as Buffer | undefined;
  const signatureHeader = req.header('x-hub-signature-256');
  if (!validSignature(rawBody, signatureHeader, env.metaAppSecret, env.isProd)) {
    console.warn('[Webhook] Invalid signature, rejecting:', {
      reason: signatureFailureReason(rawBody, signatureHeader, env.metaAppSecret, env.isProd),
      hasHeader: !!signatureHeader,
      hasBody: !!rawBody,
      bodyBytes: rawBody?.length ?? 0,
    });
    return res.sendStatus(401);
  }
  res.sendStatus(200); // answer fast; Meta retries slow/failed webhooks

  // Meta can batch several messages/statuses (even across several contacts) into one delivery. Each one is
  // processed in its own try/catch: since the 200 above already told Meta "received", a failure on one item
  // must never take the rest of the batch down with it - a single malformed message would otherwise silently
  // drop every message/status that happened to be listed after it, with no retry.
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
          try {
            // A reaction belongs to the message it's on (not a new message in the chat)
            if (msg?.type === 'reaction') {
              const applied = await applyCustomerReaction(account.workspaceId, msg.reaction);
              if (!applied) console.warn('[Webhook] Reaction to a message not in this workspace, ignored:', { id: msg?.id });
              continue;
            }
            await saveIncoming(account.workspaceId, parseWebhookMessage(msg, value.contacts));
          } catch (err) {
            console.error('[Webhook] Failed to save incoming message, skipping it (rest of the batch continues):', { id: msg?.id, type: msg?.type }, err);
          }
        }
        for (const status of value.statuses ?? []) {
          console.log('[Webhook] Status update:', {
            id: status?.id,
            status: status?.status,
            errors: status?.errors?.map((e: any) => ({ code: e.code, title: e.title })),
          });
          try {
            await applyStatus(account.workspaceId, status);
          } catch (err) {
            console.error('[Webhook] Failed to apply status update, skipping it (rest of the batch continues):', { id: status?.id, status: status?.status }, err);
          }
        }
      }
    }
  } catch (err) {
    console.error('[Webhook] Webhook processing failed', err);
  }
});
