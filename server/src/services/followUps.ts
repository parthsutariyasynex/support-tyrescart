import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { listApprovedTemplates, sendTemplateWithValues } from '../whatsapp.js';
import { withSender } from './senders.js';
import { type FollowUpVariable, followUpValues, pickFollowUpTemplate } from './followUpRules.js';
import { requireAdmin } from './permissions.js';
import { type TemplateInfo, buildSendComponents, renderTemplate } from './templateModel.js';
import { listVariables, variableValues } from './variables.js';

// Settings → Simple automations → Follow-up after 24 hours. When a customer's last message is 24 hours old and they
// haven't written since (WhatsApp's 24-hour window has closed, so only a Meta-approved template may be sent), the
// workspace's follow-up template goes out once: its own approved template named follow_up / follow_up_…, read live
// from Meta (see followUpRules.ts), its variables filled in from the contact. None approved: nothing is sent, the
// reason is logged. Never twice for the same quiet spell (followUpSentAt), never to closed, snoozed or deleted
// contacts' chats, and never in bulk to old chats: only chats whose 24 hours run out after the follow-up became
// active (followUpActiveSince). Nothing runs while Simple automations or the follow-up is off.

const HOUR = 3_600_000;
export const FOLLOW_UP_AFTER_MS = 24 * HOUR;
const CHECK_EVERY_MS = 5 * 60_000;
const BATCH = 50; // chats per workspace per check, so a backlog is worked through calmly

export { type FollowUpVariable, followUpValues, isFollowUpName, pickFollowUpTemplate } from './followUpRules.js';

// Chats due for a follow-up now in this workspace
export const dueWhere = (workspaceId: string, activeSince: Date, now: Date) => ({
  workspaceId,
  status: 'open', // not closed or snoozed
  contact: { deletedAt: null },
  // the customer's last message is 24 hours old (they haven't written since), and those 24 hours ran out after the
  // follow-up became active: old chats are never messaged in bulk
  lastInboundAt: { lte: new Date(now.getTime() - FOLLOW_UP_AFTER_MS), gt: new Date(activeSince.getTime() - FOLLOW_UP_AFTER_MS) },
  // once per quiet spell: none sent yet, or the last one was before the customer's latest message
  OR: [{ followUpSentAt: null }, { followUpSentAt: { lt: prisma.conversation.fields.lastInboundAt } }],
});

// One check across workspaces (or one, for tests); returns how many follow-ups were sent
export async function sendFollowUps(now = new Date(), workspaceId?: string) {
  const active = await prisma.automationSettings.findMany({ where: { enabled: true, followUpEnabled: true, ...(workspaceId ? { workspaceId } : {}) } });
  let sent = 0;
  for (const s of active) {
    try {
      // On, but its start isn't recorded (switched on before follow-ups existed): it starts now, so only chats whose
      // 24 hours run out from now on get one
      if (!s.followUpActiveSince) {
        await prisma.automationSettings.updateMany({ where: { workspaceId: s.workspaceId, followUpActiveSince: null }, data: { followUpActiveSince: now } });
        continue;
      }
      const due = await prisma.conversation.findMany({
        where: dueWhere(s.workspaceId, s.followUpActiveSince!, now),
        include: { contact: true },
        orderBy: { lastInboundAt: 'asc' },
        take: BATCH,
      });
      if (!due.length) continue;
      const account = await prisma.whatsAppAccount.findUnique({ where: { workspaceId: s.workspaceId } });
      if (!account) continue;
      // Live from Meta: no approved follow_up template (or none that can be filled automatically) sends nothing
      const picked = pickFollowUpTemplate(await listApprovedTemplates(account), (await listVariables(s.workspaceId)).map((v) => v.key));
      if ('problem' in picked) {
        console.warn('[follow-ups] skipped for workspace', s.workspaceId, `(${due.length} chat${due.length === 1 ? '' : 's'} due):`, picked.problem);
        continue;
      }
      for (const c of due) if (await sendOne(s.workspaceId, c, picked.template, picked.vars, account, now)) sent++;
    } catch (err) {
      console.error('[follow-ups] check failed for workspace', s.workspaceId, (err as Error).message);
    }
  }
  return sent;
}

type Due = Awaited<ReturnType<typeof prisma.conversation.findMany<{ include: { contact: true } }>>>[number];
async function sendOne(workspaceId: string, c: Due, t: TemplateInfo, vars: FollowUpVariable[], account: Parameters<typeof sendTemplateWithValues>[0], now: Date) {
  // Claimed first (compare-and-set), so two checks running at once send one follow-up
  const { count } = await prisma.conversation.updateMany({ where: { id: c.id, followUpSentAt: c.followUpSentAt }, data: { followUpSentAt: now } });
  if (!count) return false;
  const filled = followUpValues(t, vars, await variableValues(workspaceId, c.id));
  const body = 'values' in filled ? renderTemplate(t, filled.values) : renderTemplate(t, { header: {}, body: {}, buttons: {} });
  const message = await prisma.message.create({ data: { conversationId: c.id, direction: 'out', type: 'template', body, status: 'pending', automation: 'follow_up' } });
  let saved;
  try {
    if ('missing' in filled) throw new Error(`No value for ${filled.missing}: add it to the contact`);
    const wamid = await sendTemplateWithValues(account, c.contact.waId, t.name, t.language, buildSendComponents(t, filled.values));
    saved = await prisma.message.update({ where: { id: message.id }, data: { waMessageId: wamid, status: 'sent' } });
  } catch (err) {
    // Shown in the chat as failed, with the reason; not retried (the next one comes after the customer writes again)
    saved = await prisma.message.update({ where: { id: message.id }, data: { status: 'failed', error: (err as Error).message } });
  }
  await prisma.conversation.update({ where: { id: c.id }, data: { lastMessageAt: new Date() } });
  const conversation = await prisma.conversation.findUnique({ where: { id: c.id }, include: { contact: true } });
  emitToWorkspace(workspaceId, 'message:new', { conversation, message: await withSender(saved) });
  return saved.status === 'sent';
}

// Settings → Simple automations: which template the follow-up uses right now (read live from Meta), or why none
export async function followUpTemplateStatus(auth: AuthPayload) {
  await requireAdmin(auth);
  const account = await prisma.whatsAppAccount.findUnique({ where: { workspaceId: auth.workspaceId } });
  if (!account) return { template: null, problem: 'Connect a WhatsApp number first: follow-ups are sent as its templates' };
  let approved;
  try {
    approved = await listApprovedTemplates(account);
  } catch (err) {
    return { template: null, problem: `Couldn't read the templates from WhatsApp: ${(err as Error).message}` };
  }
  const picked = pickFollowUpTemplate(approved, (await listVariables(auth.workspaceId)).map((v) => v.key));
  if ('problem' in picked) return { template: null, problem: picked.problem };
  const t = picked.template;
  return {
    template: { name: t.name, language: t.language, text: [t.header?.format === 'TEXT' ? t.header.text : '', t.body.text].filter(Boolean).join('\n\n'), variables: picked.vars, others: picked.others },
    problem: null,
  };
}

// Starts the checks (every 5 minutes); returns a function that stops them
export function startFollowUps(onTick?: (sent: number) => void) {
  const tick = () =>
    sendFollowUps()
      .then((n) => {
        if (n) console.log(`[follow-ups] ${n} sent`);
        onTick?.(n);
      })
      .catch((err) => console.error('[follow-ups] check failed', err));
  const timer = setInterval(tick, CHECK_EVERY_MS);
  timer.unref(); // never keeps the process alive on its own
  return () => clearInterval(timer);
}
