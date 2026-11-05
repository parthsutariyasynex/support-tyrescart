import { z } from 'zod';
import type { AuthPayload } from '../auth.js';
import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { AppError } from './errors.js';
import { requireAdmin } from './permissions.js';
import { parse } from './validate.js';
import { logEvent, logFailure } from './logging.js';
import { type AuditSource, recordWhatsAppConnection } from './whatsappAudit.js';

const connectSchema = z.object({
  wabaId: z.string().trim().min(1),
  phoneNumberId: z.string().trim().min(1),
  accessToken: z.string().trim().min(10),
});

// Never select accessToken here: this is what clients get to see
const publicFields = { wabaId: true, phoneNumberId: true, displayPhone: true } as const;

export function getWhatsAppAccount(workspaceId: string) {
  return prisma.whatsAppAccount.findUnique({ where: { workspaceId }, select: publicFields });
}

// The permissions a token needs to send/receive messages and manage templates on the WhatsApp Business account
const REQUIRED_SCOPES = ['whatsapp_business_messaging', 'whatsapp_business_management'];

export type WhatsAppCheck = { name: string; ok: boolean; detail: string };

// One call to Meta's Graph API. Never logs or returns the token; a network failure is META_UNREACHABLE.
async function graph(path: string, token: string, init: RequestInit = {}): Promise<{ ok: boolean; data: any }> {
  try {
    const r = await fetch(`${env.graphBase}/${env.graphVersion}/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  } catch (err) {
    void logFailure('whatsapp.connect_unreachable', "Couldn't reach Meta to check the WhatsApp number", err, { category: 'whatsapp' });
    throw new AppError('Could not reach Meta. Try again.', 502, 'META_UNREACHABLE');
  }
}

const metaMessage = (data: any, fallback: string) => data?.error?.message ?? fallback;

// The 7 checks done with Meta before a number is connected. Stops at the first failure (later checks depend on the
// earlier ones) and throws, so nothing is saved; on success returns every check and the number Meta reports.
export async function verifyWhatsAppWithMeta(input: { wabaId: string; phoneNumberId: string; accessToken: string }) {
  const { wabaId, phoneNumberId, accessToken } = input;
  const checks: WhatsAppCheck[] = [];
  const pass = (name: string, detail: string) => checks.push({ name, ok: true, detail });
  const fail = (name: string, detail: string, code = 'WHATSAPP_CHECK_FAILED'): never => {
    const n = checks.length + 1;
    checks.push({ name, ok: false, detail });
    throw new AppError(`Check ${n} of 7 failed (${name}): ${detail}`, 400, code);
  };
  // Every error carries the checks that ran (for the audit log), whether a check failed or Meta was unreachable
  try {
    return await runChecks();
  } catch (err) {
    if (err && typeof err === 'object' && !('checks' in err)) (err as { checks?: WhatsAppCheck[] }).checks = [...checks];
    throw err;
  }

  async function runChecks() {

    // 1. Meta accepts the token at all
    const me = await graph('me?fields=id,name', accessToken);
    if (!me.ok) fail('Access token', metaMessage(me.data, 'Meta did not accept the token'), 'INVALID_CREDENTIALS');
    pass('Access token', `Accepted by Meta (${me.data.name ?? me.data.id})`);

    // 2. The token was issued for this server's Meta app (the app whose secret signs the webhooks)
    if (!env.metaAppId || !env.metaAppSecret)
      fail('Meta app', 'META_APP_ID and META_APP_SECRET must be set on the server to check the token', 'META_APP_NOT_CONFIGURED');
    const appToken = `${env.metaAppId}|${env.metaAppSecret}`;
    const debug = await graph(`debug_token?input_token=${encodeURIComponent(accessToken)}`, appToken);
    const info = debug.data?.data;
    if (!debug.ok || !info?.is_valid) fail('Meta app', metaMessage(debug.data, info?.error?.message ?? 'Meta could not inspect the token'));
    if (String(info.app_id) !== env.metaAppId) fail('Meta app', `The token belongs to app ${info.app_id}, not this server's app ${env.metaAppId}`);
    pass('Meta app', `Issued for app ${env.metaAppId}`);

    // 3. A permanent System User token (temporary tokens from the API Setup page stop working within a day)
    if (info.type !== 'SYSTEM_USER') fail('Permanent token', `This is a ${info.type ?? 'unknown'} token. Generate a System User token in Meta Business Settings`);
    if (info.expires_at !== 0) fail('Permanent token', `This token expires on ${new Date(info.expires_at * 1000).toISOString().slice(0, 10)}. Choose "Never" as the expiry when generating it`);
    pass('Permanent token', 'System User token that never expires');

    // 4. The permissions sending, receiving and templates need
    const scopes: string[] = info.scopes ?? [];
    const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
    if (missing.length) fail('Permissions', `The token is missing: ${missing.join(', ')}`);
    pass('Permissions', REQUIRED_SCOPES.join(', '));

    // 5. The WhatsApp Business account is reachable with this token
    const waba = await graph(`${encodeURIComponent(wabaId)}?fields=id,name`, accessToken);
    if (!waba.ok) fail('WhatsApp Business account', metaMessage(waba.data, `Account ${wabaId} is not reachable with this token`));
    pass('WhatsApp Business account', `${waba.data.name ?? wabaId} (${wabaId})`);

    // 6. The phone number belongs to that account
    const numbers = await graph(`${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name&limit=100`, accessToken);
    if (!numbers.ok) fail('Phone number', metaMessage(numbers.data, "Couldn't list the account's phone numbers"));
    const number = (numbers.data.data ?? []).find((n: any) => String(n.id) === phoneNumberId);
    if (!number) fail('Phone number', `Phone number ID ${phoneNumberId} is not in WhatsApp Business account ${wabaId}`);
    pass('Phone number', `${number.display_phone_number}${number.verified_name ? ` (${number.verified_name})` : ''}`);

    // 7. Webhooks reach this server: the app is subscribed to the account (subscribed here if it isn't yet) and the
    // app's WhatsApp webhook includes the "messages" field (incoming messages and delivery statuses)
    const subscribed = async () => {
      const r = await graph(`${encodeURIComponent(wabaId)}/subscribed_apps`, accessToken);
      return r.ok && (r.data.data ?? []).some((a: any) => String(a?.whatsapp_business_api_data?.id ?? a?.id) === env.metaAppId);
    };
    if (!(await subscribed())) {
      const sub = await graph(`${encodeURIComponent(wabaId)}/subscribed_apps`, accessToken, { method: 'POST' });
      if (!sub.ok || !(await subscribed())) fail('Webhooks', metaMessage(sub.data, `Couldn't subscribe app ${env.metaAppId} to account ${wabaId}`));
    }
    const appSubs = await graph(`${encodeURIComponent(env.metaAppId)}/subscriptions`, appToken);
    const waSub = (appSubs.data?.data ?? []).find((s: any) => s.object === 'whatsapp_business_account');
    if (!appSubs.ok || !waSub?.active) fail('Webhooks', 'The Meta app has no active WhatsApp webhook. Set the callback URL and verify token in the app\'s WhatsApp → Configuration');
    if (!(waSub.fields ?? []).some((f: any) => (f?.name ?? f) === 'messages')) fail('Webhooks', 'Subscribe the app\'s WhatsApp webhook to the "messages" field');
    pass('Webhooks', `App subscribed to the account; webhook ${waSub.callback_url ?? ''} receives messages`.trim());

    return { checks, displayPhone: String(number.display_phone_number) };
  }
}

// Manual connect (paste IDs from Meta). Admins only: it changes which number the whole workspace sends from.
// Every check with Meta passes before anything is saved. When it replaces a different number, the previous
// credentials are kept in WhatsAppAccountBackup (same transaction) so they can be restored (npm run whatsapp:restore).
// Every attempt, saved or not, is recorded in WhatsAppConnectionLog (services/whatsappAudit.ts; never the token).
export async function connectWhatsApp(auth: AuthPayload, rawInput: unknown, source: AuditSource = 'settings') {
  const { workspaceId } = auth;
  const raw = (rawInput ?? {}) as Record<string, unknown>;
  const submittedToken = typeof raw.accessToken === 'string' ? raw.accessToken : null;
  let previous: { wabaId: string; phoneNumberId: string; displayPhone: string | null } | null = null;
  let checks: WhatsAppCheck[] | null = null;
  let backupId: string | null = null;
  const audit = (status: 'success' | 'failed', extra: { newDisplayPhone?: string | null; error?: unknown } = {}) => {
    const newId = typeof raw.phoneNumberId === 'string' ? raw.phoneNumberId.trim() : null;
    const action = !previous ? 'connect' : newId && newId !== previous.phoneNumberId ? 'replace' : 'update';
    return recordWhatsAppConnection({
      workspaceId,
      actorId: auth.userId,
      action,
      status,
      source,
      previous,
      phoneNumberId: raw.phoneNumberId,
      wabaId: raw.wabaId,
      checks,
      backupId,
      secrets: [submittedToken],
      ...extra,
    });
  };

  try {
    await requireAdmin(auth);
    previous = await prisma.whatsAppAccount.findUnique({ where: { workspaceId }, select: publicFields });
    const input = parse(connectSchema, rawInput);
    const { wabaId, phoneNumberId, accessToken } = input;

    let displayPhone: string;
    try {
      ({ checks, displayPhone } = await verifyWhatsAppWithMeta(input));
    } catch (err) {
      checks = (err as { checks?: WhatsAppCheck[] }).checks ?? null;
      throw err;
    }

    const taken = await prisma.whatsAppAccount.findUnique({ where: { phoneNumberId } });
    if (taken && taken.workspaceId !== workspaceId)
      throw new AppError('Number is connected to another workspace', 409, 'NUMBER_TAKEN');

    const data = { wabaId, phoneNumberId, accessToken, displayPhone };
    const saved = await prisma.$transaction(async (tx) => {
      const before = await tx.whatsAppAccount.findUnique({ where: { workspaceId } });
      const changed = before && (before.wabaId !== wabaId || before.phoneNumberId !== phoneNumberId || before.accessToken !== accessToken);
      const backup =
        before && changed
          ? await tx.whatsAppAccountBackup.create({
              data: {
                workspaceId,
                wabaId: before.wabaId,
                phoneNumberId: before.phoneNumberId,
                displayPhone: before.displayPhone,
                accessToken: before.accessToken,
                replacedBy: auth.userId,
              },
              select: { id: true },
            })
          : null;
      const account = await tx.whatsAppAccount.upsert({
        where: { workspaceId },
        update: { ...data, updatedBy: auth.userId },
        create: { workspaceId, ...data, createdBy: auth.userId },
        select: publicFields,
      });
      return { account, before, backupId: backup?.id ?? null };
    });
    const { account, before } = saved;
    backupId = saved.backupId;

    void logEvent({
      level: 'SUCCESS',
      category: 'whatsapp',
      event: before ? 'whatsapp.number_updated' : 'whatsapp.number_connected',
      message: before && before.phoneNumberId !== phoneNumberId ? `WhatsApp number replaced: ${before.displayPhone ?? '?'} → ${displayPhone}` : `WhatsApp number connected: ${displayPhone}`,
      workspaceId,
      data: { wabaId, phoneNumberId, previousPhoneNumberId: before?.phoneNumberId ?? null, backedUp: !!backupId },
    });
    await audit('success', { newDisplayPhone: displayPhone });

    return { ...account, checks };
  } catch (err) {
    await audit('failed', { error: err });
    throw err;
  }
}
