import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { z } from 'zod';
import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { clearedAt } from './conversationClear.js';
import { recordActivity } from './activity.js';
import { AppError, notFound } from './errors.js';
import { requireConversation } from './inbox.js';
import { choicesOf, requireChoice } from './fieldChoices.js';
import { listLeadStages, requireStageValue } from './leadStages.js';
import { getPermissions, requireAdmin } from './permissions.js';
import { parse } from './validate.js';

// Customer profile (chat side panel): "Contact property" fields and "Remarks" (internal notes).
// Every member of the workspace (owner, admin, supervisor, agent) can view and edit them; a remark can be deleted
// by the person who wrote it or by an owner/admin. None of this is ever sent to the customer.
// `name` stays the customer's WhatsApp profile name (WhatsApp updates it on each message); firstName/lastName are
// the team's own and are never overwritten by incoming messages.

// The choices for the dropdown fields. The API serves them (contactFieldOptions), so the app has one source.
// Lead stages in order: the open ones, then the closed ones (won/lost). The colour marks the stage in the chat
// header's stage menu.
// Settings → Customer lifecycle: contacts per lead stage in your workspace (any role may see the totals).
// chats: only contacts with a chat, not deleted: the left menu's count of what a stage link lists in the Inbox
// (one chat per contact).
export async function leadStageCounts(auth: AuthPayload, chats = false) {
  const rows = await prisma.contact.groupBy({
    by: ['leadStage'],
    where: { workspaceId: auth.workspaceId, ...(chats ? { deletedAt: null, conversations: { some: {} } } : {}) },
    _count: { _all: true },
  });
  return rows.map((r) => ({ stage: r.leadStage, count: r._count._all }));
}


export const REMARK_MAX_LENGTH = 2000;

const values = (list: readonly { value: string }[]) => list.map((o) => o.value) as [string, ...string[]];
// Text fields: trimmed; empty clears the field (null); undefined leaves it unchanged
const text = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} is too long (max ${max} characters)`)
    .transform((v) => v || null)
    .nullable()
    .optional();
const choice = (list: readonly { value: string }[], label: string) =>
  z
    .union([z.enum(values(list), { message: `Choose a valid ${label}` }), z.literal('')])
    .transform((v) => v || null)
    .nullable()
    .optional();

const updateSchema = z.object({
  firstName: text(100, 'First name'),
  lastName: text(100, 'Last name'),
  email: z
    .string()
    .trim()
    .max(191, 'Email is too long')
    .refine((v) => !v || z.email().safeParse(v).success, 'Enter a valid email address')
    .transform((v) => (v ? v.toLowerCase() : null))
    .nullable()
    .optional(),
  companyName: text(150, 'Company name'),
  jobTitle: text(100, 'Job title'),
  // One of the workspace's stages (checked in updateContact); '' clears it
  leadStage: z
    .string()
    .trim()
    .max(20, 'Choose a valid lead stage')
    .transform((v) => v || null)
    .nullable()
    .optional(),
  // One of the workspace's choices (checked in updateContact); '' clears it
  leadSource: z.string().trim().max(20, 'Choose a valid lead source').transform((v) => v || null).nullable().optional(),
  priority: z.string().trim().max(10, 'Choose a valid priority').transform((v) => v || null).nullable().optional(),
  country: text(100, 'Country'),
  subscribed: z.boolean({ message: 'Subscriber must be yes or no' }).optional(),
});
export type ContactUpdate = z.input<typeof updateSchema>;

export async function requireContact(workspaceId: string, id: string) {
  const contact = await prisma.contact.findFirst({ where: { id, workspaceId, deletedAt: null } });
  if (!contact) throw notFound('Contact');
  return contact;
}

export async function getContact(auth: AuthPayload, id: string) {
  await getPermissions(auth); // members only
  return requireContact(auth.workspaceId, id);
}

// Only the fields sent are changed. Everyone with the chat open sees the change live (contact:updated).
export async function updateContact(auth: AuthPayload, id: string, input: ContactUpdate) {
  await getPermissions(auth);
  const before = await requireContact(auth.workspaceId, id);
  const data = parse(updateSchema, input ?? {});
  if (data.leadStage) await requireStageValue(auth.workspaceId, data.leadStage);
  if (data.leadSource) await requireChoice(auth.workspaceId, 'leadSource', data.leadSource, 'lead source');
  if (data.priority) await requireChoice(auth.workspaceId, 'priority', data.priority, 'priority');
  const changes = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  const contact = Object.keys(changes).length
    ? await prisma.contact.update({ where: { id }, data: { ...changes, updatedBy: auth.userId } })
    : before;
  await logFieldChanges(auth, before, contact);
  emitToWorkspace(auth.workspaceId, 'contact:updated', contact);
  return contact;
}

// Contact details page activity log: "Fields changed by …" with each field's old and new value (as shown in the app)
const FIELD_LABELS: Record<string, string> = {
  firstName: 'First name', lastName: 'Last name', email: 'Email', companyName: 'Company name', jobTitle: 'Job title',
  leadStage: 'Lead stage', leadSource: 'Lead source', priority: 'Priority', country: 'Country', subscribed: 'Subscriber',
};
type Choices = Record<string, readonly { value: string; label: string }[]>;
function shown(field: string, v: unknown, choices: Choices) {
  if (v === null || v === undefined || v === '') return null;
  if (field === 'subscribed') return v ? 'Yes' : 'No';
  return choices[field]?.find((o) => o.value === v)?.label ?? String(v);
}
export async function conversationOf(workspaceId: string, contactId: string) {
  return (await prisma.conversation.findFirst({ where: { workspaceId, contactId }, select: { id: true } }))?.id ?? null;
}
async function logFieldChanges(auth: AuthPayload, before: Record<string, unknown>, after: Record<string, unknown>) {
  const fields = Object.keys(FIELD_LABELS).filter((f) => before[f] !== after[f]);
  if (!fields.length) return;
  const conversationId = await conversationOf(auth.workspaceId, String(after.id));
  if (!conversationId) return;
  const choices: Choices = {
    leadStage: fields.includes('leadStage') ? await listLeadStages(auth.workspaceId) : [],
    leadSource: fields.includes('leadSource') ? await choicesOf(auth.workspaceId, 'leadSource') : [],
    priority: fields.includes('priority') ? await choicesOf(auth.workspaceId, 'priority') : [],
  };
  await recordActivity({
    workspaceId: auth.workspaceId,
    conversationId,
    actorId: auth.userId,
    type: 'contact_updated',
    data: { changes: fields.map((f) => ({ field: f, label: FIELD_LABELS[f], from: shown(f, before[f], choices), to: shown(f, after[f], choices) })) },
  });
}
async function logRemark(auth: AuthPayload, contactId: string, type: 'remark_added' | 'remark_edited' | 'remark_deleted', body: string) {
  const conversationId = await conversationOf(auth.workspaceId, contactId);
  if (conversationId) await recordActivity({ workspaceId: auth.workspaceId, conversationId, actorId: auth.userId, type, data: { text: body.slice(0, 500) } });
}

// --- Remarks

async function withAuthors<T extends { createdById: string | null }>(rows: T[]) {
  const ids = [...new Set(rows.map((r) => r.createdById).filter((x): x is string => !!x))];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  return rows.map((r) => ({ ...r, authorName: users.find((u) => u.id === r.createdById)?.name ?? null }));
}

// Newest first
export async function listRemarks(auth: AuthPayload, contactId: string) {
  await getPermissions(auth);
  await requireContact(auth.workspaceId, contactId);
  const rows = await prisma.contactRemark.findMany({ where: { contactId, workspaceId: auth.workspaceId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  return withAuthors(rows);
}

const remarkSchema = z
  .string({ message: 'Remark must be text' })
  .trim()
  .min(1, 'Write a remark first')
  .max(REMARK_MAX_LENGTH, `Remark is too long (max ${REMARK_MAX_LENGTH} characters)`);

const announceRemarks = (workspaceId: string, contactId: string) => emitToWorkspace(workspaceId, 'contact:remarks', { contactId });

export async function addRemark(auth: AuthPayload, contactId: string, body: string) {
  await getPermissions(auth);
  await requireContact(auth.workspaceId, contactId);
  const text = parse(remarkSchema, body);
  const row = await prisma.contactRemark.create({ data: { workspaceId: auth.workspaceId, contactId, body: text, createdById: auth.userId } });
  announceRemarks(auth.workspaceId, contactId);
  await logRemark(auth, contactId, 'remark_added', text);
  return (await withAuthors([row]))[0];
}

// The remark's author, or an owner/admin, can edit or delete it
async function requireOwnRemark(auth: AuthPayload, id: string, action: 'edit' | 'delete') {
  const { isAdmin } = await getPermissions(auth);
  const row = await prisma.contactRemark.findFirst({ where: { id, workspaceId: auth.workspaceId } });
  if (!row) throw notFound('Remark');
  if (!isAdmin && row.createdById !== auth.userId) throw new AppError(`Only the person who wrote a remark, or an admin, can ${action} it`, 403, 'FORBIDDEN');
  return row;
}

export async function updateRemark(auth: AuthPayload, id: string, body: string) {
  const row = await requireOwnRemark(auth, id, 'edit');
  const text = parse(remarkSchema, body);
  if (text === row.body) return (await withAuthors([row]))[0]; // unchanged: not marked as edited
  const updated = await prisma.contactRemark.update({ where: { id }, data: { body: text, editedAt: new Date(), editedById: auth.userId } });
  announceRemarks(auth.workspaceId, row.contactId);
  await logRemark(auth, row.contactId, 'remark_edited', text);
  return (await withAuthors([updated]))[0];
}

export async function deleteRemark(auth: AuthPayload, id: string) {
  const row = await requireOwnRemark(auth, id, 'delete');
  await prisma.contactRemark.delete({ where: { id } });
  announceRemarks(auth.workspaceId, row.contactId);
  await logRemark(auth, row.contactId, 'remark_deleted', row.body);
  return true;
}

// --- Files in a chat (side panel "Attachments")
// Every file sent in the chat, by the customer or your team (newest first), the same messages the chat shows (after
// "Clear chat" for this user, only what came later). The file itself: GET /inbox/messages/{id}/media.
export const FILE_TYPES = ['image', 'video', 'audio', 'voice', 'document', 'sticker'] as const;

export async function listChatFiles(auth: AuthPayload, conversationId: string) {
  await getPermissions(auth);
  await requireConversation(auth.workspaceId, conversationId);
  const hideBefore = await clearedAt(auth.userId, conversationId);
  const rows = await prisma.message.findMany({
    where: { conversationId, type: { in: [...FILE_TYPES] }, deletedAt: null, ...(hideBefore ? { createdAt: { gt: hideBefore } } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 200,
    select: { id: true, type: true, direction: true, createdAt: true, mediaMime: true, mediaName: true, mediaSize: true, mediaPath: true, waMediaId: true },
  });
  // available: the file can be opened (stored, or a customer's file WhatsApp can still give us)
  return rows.map(({ mediaPath, waMediaId, ...r }) => ({ ...r, available: !!mediaPath || !!waMediaId }));
}

// --- Read-only details shown in the panel

// Country of the phone number's calling code, e.g. 971... -> "United Arab Emirates" (null if not recognised)
export function phoneCountry(waId: string) {
  const code = parsePhoneNumberFromString(`+${waId}`)?.country;
  if (!code) return null;
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

// When your team last sent this chat a message (null if never)
export async function lastOutboundAt(conversationId: string) {
  const m = await prisma.message.findFirst({ where: { conversationId, direction: 'out' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { createdAt: true } });
  return m?.createdAt ?? null;
}

// The channel the chat runs on: WhatsApp, with the workspace's connected business number when there is one
export async function chatChannel(workspaceId: string) {
  const account = await prisma.whatsAppAccount.findUnique({ where: { workspaceId }, select: { displayPhone: true } });
  return account?.displayPhone ? `WhatsApp · ${account.displayPhone}` : 'WhatsApp';
}

// --- Contact property view (per person, per workspace)
// Default view: the workspace's order and hidden properties (Settings → Contact properties, set by admins; none =
// every property in the standard order). Personal view: this person's own order and hidden properties.
// Keys are the panel's property keys (the app ignores keys it doesn't know, so new properties still show up).
// Standard properties are camelCase keys (email, leadStage); custom ones are custom:<key> (custom:tyre_size)
const viewKeys = z.array(z.string().regex(/^(custom:)?[A-Za-z][A-Za-z0-9_]{0,39}$/, 'Invalid property key')).max(120, 'Too many properties');
const viewSchema = z.object({ personal: z.boolean(), order: viewKeys, hidden: viewKeys });
export type PropertyView = z.infer<typeof viewSchema>;

const readKeys = (json: string) => {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
};

export async function getPropertyView(auth: AuthPayload) {
  await getPermissions(auth);
  const [row, def] = await Promise.all([
    prisma.contactPropertyView.findUnique({ where: { userId_workspaceId: { userId: auth.userId, workspaceId: auth.workspaceId } } }),
    prisma.contactPropertyDefault.findUnique({ where: { workspaceId: auth.workspaceId } }),
  ]);
  const defaults = { defaultOrder: def ? readKeys(def.order) : [], defaultHidden: def ? readKeys(def.hidden) : [], labels: readLabels(def?.labels ?? null) };
  return row
    ? { personal: row.personal, order: readKeys(row.order), hidden: readKeys(row.hidden), ...defaults }
    : { personal: false, order: [], hidden: [], ...defaults };
}

// The standard properties of the profile panel (custom ones are custom:<key>); they can be renamed per workspace
export const STANDARD_PROPERTY_KEYS = [
  'firstName', 'lastName', 'email', 'phone', 'companyName', 'jobTitle', 'owner', 'leadStage', 'leadSource', 'priority', 'country',
  'subscribed', 'channel', 'lastFromYou', 'lastFromCustomer', 'waBsuid', 'waUsername',
] as const;
function readLabels(json: string | null) {
  try {
    const v = JSON.parse(json ?? '{}');
    return Object.entries(v && typeof v === 'object' ? v : {})
      .filter(([k, n]) => (STANDARD_PROPERTY_KEYS as readonly string[]).includes(k) && typeof n === 'string' && n)
      .map(([key, name]) => ({ key, name: String(name) }));
  } catch {
    return [];
  }
}

// Standard properties this workspace renamed (Settings → Contact properties), e.g. companyName → "Garage name"
export async function standardPropertyLabels(workspaceId: string) {
  const def = await prisma.contactPropertyDefault.findUnique({ where: { workspaceId }, select: { labels: true } });
  return readLabels(def?.labels ?? null);
}

// Admins only: rename a standard property for this workspace (its key and type stay); an empty name restores it
export async function renameStandardProperty(auth: AuthPayload, rawKey: unknown, rawName: unknown) {
  await requireAdmin(auth);
  const { key, name } = parse(
    z.object({
      key: z.enum(STANDARD_PROPERTY_KEYS, { message: 'Unknown property' }),
      name: z.string().trim().max(60, 'Property names can be up to 60 characters'),
    }),
    { key: rawKey, name: rawName ?? '' },
  );
  const def = await prisma.contactPropertyDefault.findUnique({ where: { workspaceId: auth.workspaceId } });
  const labels = Object.fromEntries(readLabels(def?.labels ?? null).map((l) => [l.key, l.name]));
  if (name) labels[key] = name;
  else delete labels[key];
  const data = { labels: JSON.stringify(labels), updatedBy: auth.userId };
  await prisma.contactPropertyDefault.upsert({ where: { workspaceId: auth.workspaceId }, update: data, create: { workspaceId: auth.workspaceId, order: '[]', hidden: '[]', ...data } });
  emitToWorkspace(auth.workspaceId, 'contact:properties', {});
  return getPropertyView(auth);
}

// Admins only: the workspace's default view. Everyone's panel picks it up the next time it loads.
export async function saveDefaultPropertyView(auth: AuthPayload, input: unknown) {
  await requireAdmin(auth);
  const v = parse(viewSchema.omit({ personal: true }), input);
  const data = { order: JSON.stringify([...new Set(v.order)]), hidden: JSON.stringify([...new Set(v.hidden)]), updatedBy: auth.userId };
  await prisma.contactPropertyDefault.upsert({ where: { workspaceId: auth.workspaceId }, update: data, create: { workspaceId: auth.workspaceId, ...data } });
  return getPropertyView(auth);
}

export async function savePropertyView(auth: AuthPayload, input: PropertyView) {
  await getPermissions(auth);
  const v = parse(viewSchema, input);
  const data = { personal: v.personal, order: JSON.stringify([...new Set(v.order)]), hidden: JSON.stringify([...new Set(v.hidden)]) };
  await prisma.contactPropertyView.upsert({
    where: { userId_workspaceId: { userId: auth.userId, workspaceId: auth.workspaceId } },
    update: data,
    create: { userId: auth.userId, workspaceId: auth.workspaceId, ...data },
  });
  return getPropertyView(auth);
}
