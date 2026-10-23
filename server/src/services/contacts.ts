import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { z } from 'zod';
import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToUser, emitToWorkspace } from '../realtime.js';
import { clearedAt } from './conversationClear.js';
import { previewOf, recordActivity } from './activity.js';
import { AppError, notFound } from './errors.js';
import { requireConversation } from './inbox.js';
import { choicesOf, requireChoice } from './fieldChoices.js';
import { listLeadStages, requireStageValue } from './leadStages.js';
import { getPermissions, requireAdmin } from './permissions.js';
import { parse } from './validate.js';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env.js';
import { checkFile, cleanFileName } from './inbox.js';

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


// Remarks (internal notes, "Add note") are stored in a TEXT column (65,535 bytes): up to 16,000 characters fits even
// when every character takes 4 bytes. No lower app limit.
export const REMARK_MAX_LENGTH = 16_000;

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
  if (conversationId) await recordActivity({ workspaceId: auth.workspaceId, conversationId, actorId: auth.userId, type, data: { text: previewOf(body, 500) } });
  return conversationId;
}

// --- @mentions in notes. One note_mention activity per person and note (data: remarkId, mentionedUserId, text): it
// puts the chat in that person's Mentions list and stays in their 🔔 (so a mention made while they were offline is
// still there). Editing the note adds and removes them to match its @Names; deleting the note removes them.
type MentionPerson = { id: string; name: string };

// The note's current mention records: who is mentioned
async function mentionsOf(workspaceId: string, remarkId: string) {
  const rows = await prisma.activityEvent.findMany({ where: { workspaceId, type: 'note_mention', data: { path: '$.remarkId', equals: remarkId } }, select: { id: true, data: true } });
  return rows.map((r) => ({ id: r.id, userId: (r.data as { mentionedUserId?: string } | null)?.mentionedUserId ?? '' }));
}

// Tell each newly mentioned person: their bell (kept) and a pop-up now if they're online (mention:you)
async function mentionPeople(auth: AuthPayload, conversationId: string, contact: { name: string | null; waId: string }, remarkId: string, people: MentionPerson[], text: string) {
  if (!people.length) return;
  const actor = await prisma.user.findUnique({ where: { id: auth.userId }, select: { name: true } });
  const preview = previewOf(text, 200);
  const event = { conversationId, actorName: actor?.name ?? null, contactName: contact.name || `+${contact.waId}`, text: preview };
  for (const p of people) {
    await recordActivity({ workspaceId: auth.workspaceId, conversationId, actorId: auth.userId, type: 'note_mention', data: { remarkId, mentionedUserId: p.id, text: preview } });
    emitToUser(auth.workspaceId, p.id, 'mention:you', event);
  }
}

// Someone's Mentions list or bell changed without a new mention (a note edited or deleted): their screens reload them
const mentionsChanged = (workspaceId: string, userIds: string[]) => {
  for (const id of new Set(userIds)) emitToUser(workspaceId, id, 'mentions:changed', {});
};

// Teammates whose "@Name" is in the text (a mention starts a word and ends where the name does): active members of
// the workspace, never the person writing. Used when a note is edited (adding a note gets the picked ids).
async function mentionedInText(auth: AuthPayload, text: string): Promise<MentionPerson[]> {
  if (!text.includes('@')) return [];
  const members = await prisma.member.findMany({ where: { workspaceId: auth.workspaceId, active: true, userId: { not: auth.userId } }, select: { user: { select: { id: true, name: true } } } });
  const escape = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return members
    .map((m) => m.user)
    .filter((u) => u.name.trim() && new RegExp(`(^|\\s)@${escape(u.name.trim())}(?![\\p{L}\\p{N}])`, 'u').test(text));
}

// @mentions in a note ("Add note" → @): only active members of this workspace, never yourself, each once
async function mentionedMembers(auth: AuthPayload, raw: unknown): Promise<{ id: string; name: string }[]> {
  if (raw == null) return [];
  const ids = [...new Set(parse(z.array(z.string().min(1).max(64)).max(100), raw))].filter((id) => id !== auth.userId);
  if (!ids.length) return [];
  const members = await prisma.member.findMany({ where: { workspaceId: auth.workspaceId, active: true, userId: { in: ids } }, select: { user: { select: { id: true, name: true } } } });
  if (members.length !== ids.length) throw new AppError('Mention teammates of this workspace', 400, 'BAD_USER_INPUT');
  return members.map((m) => m.user);
}

// --- Remarks

// Each remark with its author's name and its attached files (in the order they were added)
async function withAuthors<T extends { id: string; createdById: string | null }>(rows: T[]) {
  const ids = [...new Set(rows.map((r) => r.createdById).filter((x): x is string => !!x))];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const files = rows.length
    ? await prisma.remarkFile.findMany({ where: { remarkId: { in: rows.map((r) => r.id) } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, remarkId: true, name: true, mime: true, size: true } })
    : [];
  return rows.map((r) => ({
    ...r,
    authorName: users.find((u) => u.id === r.createdById)?.name ?? null,
    files: files.filter((f) => f.remarkId === r.id).map(({ remarkId: _, ...f }) => f),
  }));
}

// --- Files on internal notes (Add note → 📎). Uploaded one by one first (kept with no note yet), then attached when
// the note is saved. Images (JPEG, PNG) and documents (PDF, Word, Excel, PowerPoint, text), checked by their actual
// bytes like chat files, stored in the uploads folder. Only signed-in teammates of the workspace can open them; they are
// never sent to WhatsApp or the customer.
export const NOTE_FILES_MAX = 10;
const PENDING_KEEP_MS = 24 * 60 * 60 * 1000; // uploaded but never saved with a note: removed after a day

export async function uploadRemarkFile(auth: AuthPayload, contactId: string, bytes: Buffer | undefined, rawMime: string | undefined, rawName: unknown) {
  await getPermissions(auth);
  await requireContact(auth.workspaceId, contactId);
  const kind = (rawMime ?? '').toLowerCase().startsWith('image/') ? 'image' : 'document';
  const { mime, ext } = checkFile(bytes, rawMime, kind);
  const row = await prisma.remarkFile.create({
    data: { workspaceId: auth.workspaceId, contactId, path: '', name: cleanFileName(rawName, ext), mime, size: bytes!.length, createdById: auth.userId },
  });
  const relative = path.join(auth.workspaceId, 'notes', `${row.id}.${ext}`);
  await mkdir(path.join(env.uploadsDir, auth.workspaceId, 'notes'), { recursive: true });
  await writeFile(path.join(env.uploadsDir, relative), bytes!);
  await prisma.remarkFile.update({ where: { id: row.id }, data: { path: relative } });
  void removePendingFiles(auth); // tidy up this person's abandoned uploads
  return { id: row.id, name: row.name, mime, size: row.size };
}

async function removeFiles(rows: { id: string; path: string }[]) {
  if (!rows.length) return;
  await prisma.remarkFile.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  for (const r of rows) if (r.path) await unlink(path.join(env.uploadsDir, r.path)).catch(() => {});
}
async function removePendingFiles(auth: AuthPayload) {
  const old = await prisma.remarkFile.findMany({
    where: { workspaceId: auth.workspaceId, createdById: auth.userId, remarkId: null, createdAt: { lt: new Date(Date.now() - PENDING_KEEP_MS) } },
    select: { id: true, path: true },
  });
  await removeFiles(old).catch(() => {});
}

// The file itself, for any teammate of the workspace once it's on a note (before that, only for whoever uploaded it)
export async function readRemarkFile(auth: AuthPayload, id: string) {
  await getPermissions(auth);
  const f = await prisma.remarkFile.findFirst({ where: { id, workspaceId: auth.workspaceId, OR: [{ remarkId: { not: null } }, { createdById: auth.userId }] } });
  if (!f?.path) throw notFound('File');
  try {
    return { bytes: await readFile(path.join(env.uploadsDir, f.path)), mime: f.mime, name: f.name };
  } catch {
    throw notFound('File');
  }
}

// The files the author uploaded for this customer and is now saving with a note
async function pendingFiles(auth: AuthPayload, contactId: string, raw: unknown) {
  if (raw == null) return [];
  const ids = [...new Set(parse(z.array(z.string().min(1).max(64)).max(NOTE_FILES_MAX, `Up to ${NOTE_FILES_MAX} files per note`), raw))];
  if (!ids.length) return [];
  const rows = await prisma.remarkFile.findMany({ where: { id: { in: ids }, workspaceId: auth.workspaceId, contactId, createdById: auth.userId, remarkId: null }, select: { id: true } });
  if (rows.length !== ids.length) throw new AppError('Attach the files again: some of them are no longer available', 400, 'BAD_USER_INPUT');
  return ids;
}

// Newest first
export async function listRemarks(auth: AuthPayload, contactId: string) {
  await getPermissions(auth);
  await requireContact(auth.workspaceId, contactId);
  const rows = await prisma.contactRemark.findMany({ where: { contactId, workspaceId: auth.workspaceId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  return withAuthors(rows);
}

// Internal notes in the chat (yellow bubbles between the messages): the chat customer's remarks, oldest first, after
// "Clear chat" for this user only what came later (like the messages). Read-only here; notes are never sent to
// WhatsApp or the customer (they are only ever stored as remarks).
export async function listChatNotes(auth: AuthPayload, conversationId: string) {
  await getPermissions(auth);
  const conversation = await requireConversation(auth.workspaceId, conversationId);
  const hideBefore = await clearedAt(auth.userId, conversationId);
  const rows = await prisma.contactRemark.findMany({
    where: { contactId: conversation.contactId, workspaceId: auth.workspaceId, ...(hideBefore ? { createdAt: { gt: hideBefore } } : {}) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return withAuthors(rows);
}

const remarkSchema = z
  .string({ message: 'Remark must be text' })
  .trim()
  .min(1, 'Write a remark first')
  .max(REMARK_MAX_LENGTH, `Remark is too long (max ${REMARK_MAX_LENGTH} characters)`);
// A note with files may have no text
const remarkTextOrEmpty = z.string({ message: 'Remark must be text' }).trim().max(REMARK_MAX_LENGTH, `Remark is too long (max ${REMARK_MAX_LENGTH} characters)`);

const announceRemarks = (workspaceId: string, contactId: string) => emitToWorkspace(workspaceId, 'contact:remarks', { contactId });

// mentions: user ids of teammates @mentioned in the note. Each gets the chat in their Mentions list and is told at once
// (mention:you: a pop-up and a desktop notification)
// files: ids of images / documents uploaded for it (uploadRemarkFile); with files the text may be empty
export async function addRemark(auth: AuthPayload, contactId: string, body: string, mentions?: unknown, files?: unknown) {
  await getPermissions(auth);
  const contact = await requireContact(auth.workspaceId, contactId);
  const fileIds = await pendingFiles(auth, contactId, files);
  const text = fileIds.length ? parse(remarkTextOrEmpty, body ?? '') : parse(remarkSchema, body);
  const mentioned = await mentionedMembers(auth, mentions);
  const row = await prisma.contactRemark.create({ data: { workspaceId: auth.workspaceId, contactId, body: text, createdById: auth.userId } });
  if (fileIds.length) await prisma.remarkFile.updateMany({ where: { id: { in: fileIds }, remarkId: null }, data: { remarkId: row.id } });
  announceRemarks(auth.workspaceId, contactId);
  const conversationId = await logRemark(auth, contactId, 'remark_added', text);
  if (conversationId) await mentionPeople(auth, conversationId, contact, row.id, mentioned, text);
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
  const hasFiles = (await prisma.remarkFile.count({ where: { remarkId: id } })) > 0;
  const text = parse(hasFiles ? remarkTextOrEmpty : remarkSchema, body);
  if (text === row.body) return (await withAuthors([row]))[0]; // unchanged: not marked as edited
  const updated = await prisma.contactRemark.update({ where: { id }, data: { body: text, editedAt: new Date(), editedById: auth.userId } });
  announceRemarks(auth.workspaceId, row.contactId);
  const conversationId = await logRemark(auth, row.contactId, 'remark_edited', text);
  // Mentions follow the edited text: an @Name taken out removes that mention (Mentions list, bell); a new one is
  // mentioned (and told); the ones still there keep their mention, with the new text
  if (conversationId) {
    const before = await mentionsOf(auth.workspaceId, id);
    const now = await mentionedInText(auth, text);
    const gone = before.filter((m) => !now.some((p) => p.id === m.userId));
    const kept = before.filter((m) => now.some((p) => p.id === m.userId));
    const added = now.filter((p) => !before.some((m) => m.userId === p.id));
    if (gone.length) await prisma.activityEvent.deleteMany({ where: { id: { in: gone.map((m) => m.id) } } });
    for (const m of kept) await prisma.activityEvent.update({ where: { id: m.id }, data: { data: { remarkId: id, mentionedUserId: m.userId, text: previewOf(text, 200) } } });
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id: row.contactId }, select: { name: true, waId: true } });
    await mentionPeople(auth, conversationId, contact, id, added, text);
    mentionsChanged(auth.workspaceId, [...gone, ...kept].map((m) => m.userId));
  }
  return (await withAuthors([updated]))[0];
}

export async function deleteRemark(auth: AuthPayload, id: string) {
  const row = await requireOwnRemark(auth, id, 'delete');
  await removeFiles(await prisma.remarkFile.findMany({ where: { remarkId: id }, select: { id: true, path: true } })); // its files go too
  // its mentions go too: off the Mentions lists and out of the bells
  const mentions = await mentionsOf(auth.workspaceId, id);
  if (mentions.length) await prisma.activityEvent.deleteMany({ where: { id: { in: mentions.map((m) => m.id) } } });
  await prisma.contactRemark.delete({ where: { id } });
  mentionsChanged(auth.workspaceId, mentions.map((m) => m.userId));
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
