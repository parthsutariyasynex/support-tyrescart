// Audit trail of WhatsApp connection changes (WhatsAppConnectionLog): written by connectWhatsApp (services/settings.ts)
// and the restore script, read by Settings → WhatsApp connection activity. Writing never breaks the operation it
// records. Secrets never reach the table: tokens, app secrets, JWTs and passwords are redacted from every text.
import type { AuthPayload } from '../auth.js';
import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { AppError } from './errors.js';
import { logFailure } from './logging.js';

export type AuditCheck = { name: string; ok: boolean; detail: string };
export type AuditAction = 'connect' | 'replace' | 'update' | 'restore';
export type AuditSource = 'settings' | 'api' | 'script';

const REDACTED = '[redacted]';
const SECRET_PATTERNS: RegExp[] = [
  /\bEAA[A-Za-z0-9]{20,}/g, // Meta access tokens (user, system user, page)
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, // JWTs
  /\b\d{6,}\|[\w-]{16,}/g, // Meta app tokens (APP_ID|APP_SECRET)
  /\bBearer\s+\S+/gi,
];
// key=value / "key": "value" pairs whose value is a secret: the key is kept, the value redacted
const SECRET_PAIR = /\b(access_?token|input_token|accessToken|client_secret|app_?secret|appsecret_proof|password|passwd|jwt|secret)(["']?\s*[=:]\s*["']?)[^\s"'&,}]+/gi;

// Removes secrets from text: the given values (e.g. the token just submitted), this server's own secrets, and
// anything shaped like a token, JWT or "password=..."
export function redactSecrets(text: string | null | undefined, secrets: (string | null | undefined)[] = []): string | null {
  if (text == null) return null;
  let out = String(text);
  for (const s of [...secrets, env.metaAppSecret, env.jwtSecret, process.env.SMTP_PASS])
    if (s && s.length >= 6) out = out.split(s).join(REDACTED);
  out = out.replace(SECRET_PAIR, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`);
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
  return out.slice(0, 4000);
}

const short = (v: unknown, max = 64) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export type AuditEntry = {
  workspaceId: string;
  actorId?: string | null;
  // For actions without a signed-in person (the restore script), e.g. "command line (parth)"
  actorLabel?: string | null;
  action: AuditAction;
  status: 'success' | 'failed';
  source: AuditSource;
  previous?: { displayPhone?: string | null; phoneNumberId?: string | null; wabaId?: string | null } | null;
  newDisplayPhone?: string | null;
  phoneNumberId?: unknown;
  wabaId?: unknown;
  checks?: AuditCheck[] | null;
  backupId?: string | null;
  error?: unknown;
  // Values to redact wherever they appear (the submitted token)
  secrets?: (string | null | undefined)[];
};

// Saves one entry. Never throws: an audit failure is reported in the backend logs, the operation goes on.
export async function recordWhatsAppConnection(e: AuditEntry): Promise<void> {
  try {
    const actor = e.actorId ? await prisma.user.findUnique({ where: { id: e.actorId }, select: { name: true, email: true } }) : null;
    const secrets = e.secrets ?? [];
    const checks = e.checks?.map((c) => ({ name: c.name, ok: !!c.ok, detail: redactSecrets(c.detail, secrets) ?? '' })) ?? null;
    const err = e.error as { message?: string; code?: string } | undefined;
    await prisma.whatsAppConnectionLog.create({
      data: {
        workspaceId: e.workspaceId,
        actorId: e.actorId ?? null,
        actorName: actor?.name?.slice(0, 191) ?? e.actorLabel?.slice(0, 191) ?? null,
        actorEmail: actor?.email?.slice(0, 191) ?? null,
        action: e.action,
        status: e.status,
        source: e.source,
        previousDisplayPhone: short(e.previous?.displayPhone, 50),
        previousPhoneNumberId: short(e.previous?.phoneNumberId),
        previousWabaId: short(e.previous?.wabaId),
        newDisplayPhone: short(e.newDisplayPhone, 50),
        phoneNumberId: short(e.phoneNumberId),
        wabaId: short(e.wabaId),
        checks: checks ?? undefined,
        checksPassed: checks?.filter((c) => c.ok).length ?? 0,
        backupCreated: !!e.backupId,
        backupId: e.backupId ?? null,
        errorCode: e.status === 'failed' ? (short(err?.code, 50) ?? 'ERROR') : null,
        errorReason: e.status === 'failed' ? redactSecrets(err?.message ?? String(e.error ?? 'Unknown error'), secrets) : null,
      },
    });
  } catch (err) {
    void logFailure('whatsapp.audit_failed', "Couldn't save a WhatsApp connection audit entry", err, { category: 'whatsapp', workspaceId: e.workspaceId });
  }
}

// --- reading (Settings → WhatsApp connection activity) ---

export type AuditFilter = { workspaceId?: string | null; actorId?: string | null; status?: string | null; from?: string | null; to?: string | null };

// Dates are days in Asia/Dubai (UTC+4 all year, no daylight saving)
const DUBAI_OFFSET = '+04:00';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
function dubaiDay(day: string | null | undefined, end: boolean): Date | undefined {
  if (!day) return undefined;
  if (!DAY.test(day)) throw new AppError('Dates must be YYYY-MM-DD', 400, 'BAD_USER_INPUT');
  const d = new Date(`${day}T00:00:00${DUBAI_OFFSET}`);
  if (Number.isNaN(d.getTime())) throw new AppError('Dates must be YYYY-MM-DD', 400, 'BAD_USER_INPUT');
  return end ? new Date(d.getTime() + 24 * 3600 * 1000) : d;
}

// The workspaces whose activity you may see: those you're an active owner or admin of
async function adminWorkspaces(userId: string) {
  const members = await prisma.member.findMany({
    where: { userId, active: true, role: { in: ['owner', 'admin'] } },
    select: { workspace: { select: { id: true, name: true } } },
  });
  return members.map((m) => m.workspace).sort((a, b) => a.name.localeCompare(b.name));
}

export async function listWhatsAppConnectionLogs(auth: AuthPayload, filter: AuditFilter = {}, first = 50, offset = 0) {
  const workspaces = await adminWorkspaces(auth.userId);
  if (!workspaces.some((w) => w.id === auth.workspaceId)) throw new AppError('Only admins can do this', 403, 'FORBIDDEN');
  const allowed = workspaces.map((w) => w.id);
  if (filter.workspaceId && !allowed.includes(filter.workspaceId)) throw new AppError('Only admins of that workspace can see its activity', 403, 'FORBIDDEN');
  if (filter.status && !['success', 'failed'].includes(filter.status)) throw new AppError('Status is success or failed', 400, 'BAD_USER_INPUT');
  const from = dubaiDay(filter.from, false);
  const to = dubaiDay(filter.to, true);

  const scope = { workspaceId: filter.workspaceId ? filter.workspaceId : { in: allowed } };
  const where = {
    ...scope,
    ...(filter.actorId ? { actorId: filter.actorId } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
  };
  const take = Math.min(Math.max(first, 1), 100);
  const [nodes, total, actors] = await Promise.all([
    prisma.whatsAppConnectionLog.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip: Math.max(offset, 0) }),
    prisma.whatsAppConnectionLog.count({ where }),
    prisma.whatsAppConnectionLog.findMany({ where: { ...scope, actorId: { not: null } }, distinct: ['actorId'], select: { actorId: true, actorName: true, actorEmail: true } }),
  ]);
  const names = new Map(workspaces.map((w) => [w.id, w.name]));
  return {
    nodes: nodes.map((n) => ({ ...n, workspaceName: names.get(n.workspaceId) ?? null, checks: n.checks ? JSON.stringify(n.checks) : null })),
    total,
    workspaces,
    admins: actors.map((a) => ({ id: a.actorId!, name: a.actorName ?? a.actorEmail ?? a.actorId!, email: a.actorEmail })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}
