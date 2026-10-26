import crypto from 'node:crypto';
import { Router } from 'express';
import { env } from '../env.js';
import { applyStatus, isCustomerMessage, parseWebhookMessage, saveIncoming } from '../messages.js';
import { applyCustomerReaction } from '../services/reactions.js';
import { prisma } from '../prisma.js';
import { errorCodeOf, errorDetailsOf, logEvent } from '../services/logging.js';

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

// Calls events (WhatsApp Business Calling) in a webhook change: how many (anything but an array counts as none)
export function callsCount(value: any): number {
  return Array.isArray(value?.calls) ? value.calls.length : 0;
}

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
    void logEvent({
      level: 'WARNING',
      category: 'webhook',
      event: 'webhook.invalid_signature',
      message: `Rejected a webhook: ${signatureFailureReason(rawBody, signatureHeader, env.metaAppSecret, env.isProd)}`,
      data: { hasHeader: !!signatureHeader, hasBody: !!rawBody, bodyBytes: rawBody?.length ?? 0 },
    });
    return res.sendStatus(401);
  }
  res.sendStatus(200); // answer fast; Meta retries slow/failed webhooks

  // Meta can batch several messages/statuses (even across several contacts) into one delivery. Each one is
  // processed in its own try/catch: since the 200 above already told Meta "received", a failure on one item
  // must never take the rest of the batch down with it - a single malformed message would otherwise silently
  // drop every message/status that happened to be listed after it, with no retry.
  // Counted for one summary entry per webhook (the request id ties it to the entries of each message and status)
  const counts = { messages: 0, statuses: 0, failed: 0, calls: 0 };
  // What failed, in words (the first few), for the summary
  const failures: string[] = [];
  const started = Date.now();
  const workspaceIds = new Set<string>();
  try {
    for (const entry of req.body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        const phoneNumberId = value?.metadata?.phone_number_id;
        console.log('[Webhook] Event change:', { field: change.field, phoneNumberId, messagesCount: value?.messages?.length, statusesCount: value?.statuses?.length });
        // Only how many: never the call payload (caller id, call metadata)
        const calls = callsCount(value);
        if (calls > 0) console.log('[Webhook] Calls event:', { count: calls });
        counts.calls += calls;
        if (!phoneNumberId) continue;
        const account = await prisma.whatsAppAccount.findUnique({ where: { phoneNumberId } });
        if (!account) {
          console.warn(`[Webhook] No WhatsAppAccount found for phoneNumberId: ${phoneNumberId}`);
          void logEvent({ level: 'WARNING', category: 'webhook', event: 'webhook.unknown_number', message: 'Webhook for a WhatsApp number not connected to any workspace, ignored', direction: 'in', outcome: 'ignored', reason: `Meta sent a webhook for number id ${phoneNumberId}, which no workspace has connected`, data: { phoneNumberId, messages: value?.messages?.length ?? 0, statuses: value?.statuses?.length ?? 0 } });
          continue;
        }
        workspaceIds.add(account.workspaceId);

        for (const msg of value.messages ?? []) {
          console.log('[Webhook] Incoming message:', { id: msg?.id, type: msg?.type, ...(msg?.errors ? { errors: msg.errors } : {}) });
          counts.messages++;
          try {
            // A reaction belongs to the message it's on (not a new message in the chat)
            if (msg?.type === 'reaction') {
              const applied = await applyCustomerReaction(account.workspaceId, msg.reaction);
              if (!applied) console.warn('[Webhook] Reaction to a message not in this workspace, ignored:', { id: msg?.id });
              void logEvent({
                level: applied ? 'SUCCESS' : 'WARNING',
                category: 'webhook',
                event: applied ? 'webhook.reaction' : 'webhook.reaction_unmatched',
                message: applied ? "Customer's reaction applied" : 'Reaction to a message not in this workspace, ignored',
                direction: 'in',
                outcome: applied ? 'applied' : 'ignored',
                workspaceId: account.workspaceId,
                waMessageId: msg?.reaction?.message_id ?? null,
                data: { reactionWaMessageId: msg?.id ?? null, removed: !msg?.reaction?.emoji },
              });
              continue;
            }
            // Meta's own notices aren't the customer writing: logged only (no window, no unread, no auto-reply)
            if (!isCustomerMessage(msg)) {
              console.log('[Webhook] Not a customer message, not saved:', { id: msg?.id, type: msg?.type });
              void logEvent({ level: 'SUCCESS', category: 'webhook', event: 'webhook.notice', message: `Meta notice (${msg?.type}), not a customer message: not saved`, direction: 'in', outcome: 'ignored', reason: `Meta sent a "${msg?.type}" notice (not something the customer wrote), so it isn't saved as a message`, workspaceId: account.workspaceId, waMessageId: msg?.id ?? null, data: { type: msg?.type ?? null }, fileOnly: true });
              continue;
            }
            await saveIncoming(account.workspaceId, parseWebhookMessage(msg, value.contacts));
          } catch (err) {
            console.error('[Webhook] Failed to save incoming message, skipping it (rest of the batch continues):', { id: msg?.id, type: msg?.type }, err);
            counts.failed++;
            failures.push(`message ${msg?.id} (${msg?.type}): ${(err as Error)?.message ?? err}`);
            void logEvent({
              level: 'ERROR',
              category: 'webhook',
              event: 'webhook.message_failed',
              message: `Couldn't save an incoming message: ${(err as Error)?.message ?? String(err)}`,
              workspaceId: account.workspaceId,
              direction: 'in',
              outcome: 'failed',
              reason: `Saving WhatsApp message ${msg?.id} (${msg?.type}) from this webhook threw an error; the rest of the webhook continued`,
              waMessageId: msg?.id ?? null,
              errorCode: errorCodeOf(err),
              errorDetails: errorDetailsOf(err),
              data: { waMessageId: msg?.id, type: msg?.type, error: err },
            });
          }
        }
        for (const status of value.statuses ?? []) {
          console.log('[Webhook] Status update:', {
            id: status?.id,
            status: status?.status,
            errors: status?.errors?.map((e: any) => ({ code: e.code, title: e.title })),
          });
          counts.statuses++;
          try {
            await applyStatus(account.workspaceId, status);
          } catch (err) {
            console.error('[Webhook] Failed to apply status update, skipping it (rest of the batch continues):', { id: status?.id, status: status?.status }, err);
            counts.failed++;
            failures.push(`status "${status?.status}" for ${status?.id}: ${(err as Error)?.message ?? err}`);
            void logEvent({
              level: 'ERROR',
              category: 'webhook',
              event: 'webhook.status_failed',
              message: `Couldn't apply a status update: ${(err as Error)?.message ?? String(err)}`,
              workspaceId: account.workspaceId,
              direction: 'out',
              outcome: 'failed',
              reason: `Applying status "${status?.status}" to WhatsApp message ${status?.id} threw an error; the rest of the webhook continued`,
              waMessageId: status?.id ?? null,
              errorCode: errorCodeOf(err),
              errorDetails: errorDetailsOf(err),
              data: { waMessageId: status?.id, status: status?.status, error: err },
            });
          }
        }
      }
    }
  } catch (err) {
    console.error('[Webhook] Webhook processing failed', err);
    void logEvent({ level: 'ERROR', category: 'webhook', event: 'webhook.failed', message: `Webhook processing failed: ${(err as Error)?.message ?? String(err)}`, direction: 'in', outcome: 'failed', reason: 'Reading or processing the webhook threw an error before it finished', durationMs: Date.now() - started, errorDetails: errorDetailsOf(err), data: { ...counts, error: err } });
    return;
  }
  // One summary per webhook, whatever it held (messages, statuses, calls or other fields), with how long it took
  void logEvent({
    level: counts.failed ? 'WARNING' : 'SUCCESS',
    category: 'webhook',
    event: 'webhook.received',
    message: `Webhook: ${counts.messages} message(s), ${counts.statuses} status update(s)${counts.calls ? `, ${counts.calls} call event(s)` : ''}${counts.failed ? `, ${counts.failed} failed` : ''}`,
    direction: 'in',
    outcome: counts.failed ? 'partly failed' : 'processed',
    reason: `Meta called the webhook with ${counts.messages} message(s), ${counts.statuses} status update(s)${counts.calls ? `, ${counts.calls} call event(s)` : ''}`,
    workspaceId: workspaceIds.size === 1 ? [...workspaceIds][0] : null,
    durationMs: Date.now() - started,
    errorDetails: failures.length ? `${failures.length} item(s) failed (each has its own entry, same request id): ${failures.slice(0, 3).join('; ')}` : null,
    data: { ...counts, fields: [...new Set((req.body?.entry ?? []).flatMap((e: any) => (e?.changes ?? []).map((c: any) => c?.field)).filter(Boolean))] },
  });
});
