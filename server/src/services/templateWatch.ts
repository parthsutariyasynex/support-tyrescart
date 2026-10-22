import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { listTemplates } from '../whatsapp.js';
import { isFollowUpName } from './followUpRules.js';

// Watching the follow-up template's review at Meta. A follow_up / follow_up_… template that is being reviewed
// (created or edited in Settings → Message templates, or found in review when the server starts) is checked at
// growing intervals until Meta decides. Then the workspace is told ('templates:status': admins see a toast, the
// Simple automations page refreshes its follow-up status) and watching stops. In memory only: after a restart, the
// start-up scan picks up anything still in review.

const FIRST_GAP_MS = 60_000; // first check a minute after it's submitted (Meta often decides within minutes)
const MAX_GAP_MS = 15 * 60_000; // then every 2, 4, 8, at most 15 minutes: one list call per check
const GIVE_UP_MS = 48 * 3_600_000; // Meta decides within 24 hours; stop watching after 48
const TICK_MS = 30_000;
// Still being decided at Meta; anything else (APPROVED, REJECTED, PAUSED, DISABLED…) is a decision
const IN_REVIEW = new Set(['PENDING', 'IN_APPEAL']);

type Watch = { since: number; nextAt: number; gap: number; failures: number; last: Map<string, string> };
const watching = new Map<string, Watch>();
const keyOf = (t: { name: string; language: string }) => `${t.name}|${t.language}`;

export type TemplateStatusEvent = { name: string; language: string; status: string; category: string; rejectedReason: string | null };
type Notify = (workspaceId: string, e: TemplateStatusEvent) => void;
const defaultNotify: Notify = (workspaceId, e) => {
  emitToWorkspace(workspaceId, 'templates:status', e);
  emitToWorkspace(workspaceId, 'templates:changed', {});
};

// Start (or keep) watching a workspace's follow-up templates; `known` = statuses already seen (name|language → status)
export function watchFollowUpTemplates(workspaceId: string, known: Record<string, string> = {}, now = Date.now()) {
  const w = watching.get(workspaceId);
  if (w) {
    for (const [k, s] of Object.entries(known)) w.last.set(k, s);
    w.nextAt = Math.min(w.nextAt, now + FIRST_GAP_MS);
    w.gap = FIRST_GAP_MS;
    return;
  }
  watching.set(workspaceId, { since: now, nextAt: now + FIRST_GAP_MS, gap: FIRST_GAP_MS, failures: 0, last: new Map(Object.entries(known)) });
}
export const isWatching = (workspaceId: string) => watching.has(workspaceId);
export const stopWatching = (workspaceId?: string) => (workspaceId ? watching.delete(workspaceId) : watching.clear());

// Meta's "slow down" answers: wait the longest gap before asking again
const rateLimited = (message: string) => /request limit|rate limit|too many calls|#4\)|#80008|#613/i.test(message);

// One check of every workspace that is due (tests pass their own `now` and `notify`)
export async function checkTemplateWatches(now = Date.now(), notify: Notify = defaultNotify) {
  for (const [workspaceId, w] of watching) {
    if (now < w.nextAt) continue;
    if (now - w.since > GIVE_UP_MS) {
      console.warn('[template-watch] still in review after 48 hours, no longer checking', workspaceId);
      watching.delete(workspaceId);
      continue;
    }
    const account = await prisma.whatsAppAccount.findUnique({ where: { workspaceId } });
    if (!account) {
      watching.delete(workspaceId);
      continue;
    }
    let templates;
    try {
      templates = (await listTemplates(account)).filter((t) => isFollowUpName(t.name));
    } catch (err) {
      const message = (err as Error).message;
      w.failures += 1;
      w.gap = rateLimited(message) ? MAX_GAP_MS : Math.min(w.gap * 2, MAX_GAP_MS);
      w.nextAt = now + w.gap;
      console.warn(`[template-watch] check failed (${w.failures}), next in ${Math.round(w.gap / 60_000)} min:`, message);
      continue;
    }
    w.failures = 0;
    for (const t of templates) {
      const before = w.last.get(keyOf(t));
      // decided since the last look (or since it was submitted): tell the workspace once
      if (before && IN_REVIEW.has(before) && !IN_REVIEW.has(t.status))
        notify(workspaceId, { name: t.name, language: t.language, status: t.status, category: t.category, rejectedReason: t.rejectedReason });
      w.last.set(keyOf(t), t.status);
    }
    if (!templates.some((t) => IN_REVIEW.has(t.status))) {
      watching.delete(workspaceId); // nothing left in review: stop
      continue;
    }
    w.gap = Math.min(w.gap * 2, MAX_GAP_MS);
    w.nextAt = now + w.gap;
  }
}

// At start-up: workspaces using the follow-up whose follow_up template is still in review (one call each, spaced out)
async function scanOnStart() {
  const rows = await prisma.automationSettings.findMany({ where: { enabled: true, followUpEnabled: true, workspace: { whatsapp: { isNot: null } } }, select: { workspaceId: true } });
  for (const { workspaceId } of rows) {
    const account = await prisma.whatsAppAccount.findUnique({ where: { workspaceId } });
    if (!account) continue;
    try {
      const inReview = (await listTemplates(account)).filter((t) => isFollowUpName(t.name) && IN_REVIEW.has(t.status));
      if (inReview.length) watchFollowUpTemplates(workspaceId, Object.fromEntries(inReview.map((t) => [keyOf(t), t.status])));
    } catch (err) {
      console.warn('[template-watch] start-up check failed for workspace', workspaceId, (err as Error).message);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

// Starts the watcher; returns a function that stops it
export function startTemplateWatch() {
  const first = setTimeout(() => void scanOnStart().catch((err) => console.error('[template-watch] start-up scan failed', err)), 10_000);
  const timer = setInterval(() => void checkTemplateWatches().catch((err) => console.error('[template-watch] check failed', err)), TICK_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
