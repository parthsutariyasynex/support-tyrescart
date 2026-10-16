import { z } from 'zod';
import type { AuthPayload } from '../auth.js';
import { prisma } from '../prisma.js';
import { emitToWorkspace } from '../realtime.js';
import { recordActivity } from './activity.js';
import { conversationOf, requireContact } from './contacts.js';
import { AppError, notFound } from './errors.js';
import { getPermissions, requireAdmin } from './permissions.js';
import { parse } from './validate.js';

// Settings → Contact properties → Add column: properties a workspace adds to every contact (e.g. "Tyre size",
// "Vehicle model"). Admins create, rename and remove them; everyone fills them in from the profile panel, like the
// standard properties. Values are checked against the property's type here.

// Shown by these names in Settings (as in SleekFlow); `value` is what's stored
export const CUSTOM_TYPES = [
  { value: 'text', label: 'SingleLineText' },
  { value: 'multiline', label: 'MultiLineText' },
  { value: 'number', label: 'Number' },
  { value: 'options', label: 'Options' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'datetime', label: 'DateTime' },
  { value: 'date', label: 'Date' },
  { value: 'email', label: 'Email' },
  { value: 'url', label: 'Url' },
] as const;
type CustomType = (typeof CUSTOM_TYPES)[number]['value'];
const MAX_PROPERTIES = 50;
const MAX_OPTIONS = 50;
const VALUE_MAX = 500;
const MULTILINE_MAX = 2000;

// "Tyre size (inches)" → tyre_size_inches
export function propertyKey(name: string) {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, 40)
    .replace(/_+$/, '');
}

type Row = { id: string; name: string; key: string; type: string; options: string | null; createdAt: Date };
const optionsOf = (json: string | null) => {
  try {
    const v = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const toProperty = (p: Row) => ({ id: p.id, name: p.name, key: p.key, type: p.type, options: optionsOf(p.options), createdAt: p.createdAt });

const nameSchema = z.string().trim().min(1, 'Enter a property name').max(60, 'Property names can be up to 60 characters');
const optionsSchema = z
  .array(z.string().trim().min(1).max(60, 'Choices can be up to 60 characters'))
  .max(MAX_OPTIONS, `Up to ${MAX_OPTIONS} choices`)
  .transform((list) => [...new Set(list)]);
const createSchema = z.object({
  name: nameSchema,
  type: z.enum(CUSTOM_TYPES.map((t) => t.value) as [CustomType, ...CustomType[]], { message: 'Choose a property type' }),
  options: optionsSchema.optional(),
});
const updateSchema = z.object({ name: nameSchema.optional(), options: optionsSchema.optional() });

export async function listCustomProperties(auth: AuthPayload) {
  await getPermissions(auth);
  const rows = await prisma.contactCustomProperty.findMany({ where: { workspaceId: auth.workspaceId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return rows.map(toProperty);
}

const announce = (workspaceId: string) => emitToWorkspace(workspaceId, 'contact:properties', {});

export async function createCustomProperty(auth: AuthPayload, rawInput: unknown) {
  await requireAdmin(auth);
  const input = parse(createSchema, rawInput ?? {});
  const key = propertyKey(input.name);
  if (!key) throw new AppError('Use letters in the property name', 400, 'BAD_USER_INPUT');
  if (input.type === 'options' && !input.options?.length) throw new AppError('Add at least one choice', 400, 'BAD_USER_INPUT');
  if ((await prisma.contactCustomProperty.count({ where: { workspaceId: auth.workspaceId } })) >= MAX_PROPERTIES)
    throw new AppError(`A workspace can have up to ${MAX_PROPERTIES} custom properties`, 400, 'BAD_USER_INPUT');
  if (await prisma.contactCustomProperty.findUnique({ where: { workspaceId_key: { workspaceId: auth.workspaceId, key } } }))
    throw new AppError(`A property with the key "${key}" already exists`, 409, 'CONFLICT');
  const row = await prisma.contactCustomProperty.create({
    data: {
      workspaceId: auth.workspaceId,
      name: input.name,
      key,
      type: input.type,
      options: input.type === 'options' ? JSON.stringify(input.options) : null,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    },
  });
  announce(auth.workspaceId);
  return toProperty(row);
}

async function requireProperty(workspaceId: string, id: string) {
  const p = await prisma.contactCustomProperty.findFirst({ where: { id, workspaceId } });
  if (!p) throw notFound('Property');
  return p;
}

// Rename, or change the choices of an Options property (the key and type stay)
export async function updateCustomProperty(auth: AuthPayload, id: string, rawInput: unknown) {
  await requireAdmin(auth);
  const p = await requireProperty(auth.workspaceId, id);
  const input = parse(updateSchema, rawInput ?? {});
  if (input.options !== undefined && p.type !== 'options') throw new AppError('Only Options properties have choices', 400, 'BAD_USER_INPUT');
  if (input.options !== undefined && !input.options.length) throw new AppError('Add at least one choice', 400, 'BAD_USER_INPUT');
  const row = await prisma.contactCustomProperty.update({
    where: { id },
    data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.options !== undefined ? { options: JSON.stringify(input.options) } : {}), updatedBy: auth.userId },
  });
  announce(auth.workspaceId);
  return toProperty(row);
}

// Removes the column and every contact's value for it (the admin confirms first in the app)
export async function deleteCustomProperty(auth: AuthPayload, id: string) {
  await requireAdmin(auth);
  await requireProperty(auth.workspaceId, id);
  await prisma.contactCustomProperty.delete({ where: { id } });
  announce(auth.workspaceId);
  return true;
}

// The value as stored, or null to clear it; throws with a message the panel shows. DateTime is the date and time as
// entered (YYYY-MM-DDTHH:mm, no time zone conversion).
export function normalizeValue(type: string, options: string[], raw: string) {
  const v = type === 'multiline' ? raw.replace(/\r\n/g, '\n').trim() : raw.trim();
  if (!v) return null;
  const bad = (message: string) => new AppError(message, 400, 'BAD_USER_INPUT');
  switch (type) {
    case 'number': {
      const n = Number(v.replace(/,/g, ''));
      if (!Number.isFinite(n)) throw bad('Enter a number');
      return String(n);
    }
    case 'date': {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      if (!m || !d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw bad('Enter a valid date');
      return v;
    }
    case 'datetime': {
      const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(v);
      const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
      if (!m || !d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3] || d.getUTCHours() !== +m[4] || d.getUTCMinutes() !== +m[5])
        throw bad('Enter a valid date and time');
      return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
    }
    case 'multiline':
      if (v.length > MULTILINE_MAX) throw bad(`Up to ${MULTILINE_MAX} characters`);
      return v;
    case 'email':
      if (v.length > 191 || !z.email().safeParse(v).success) throw bad('Enter a valid email address');
      return v.toLowerCase();
    case 'url':
      try {
        const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`);
        if (!['http:', 'https:'].includes(u.protocol) || !u.hostname.includes('.')) throw new Error();
        if (u.href.length > VALUE_MAX) throw new Error();
        return u.href;
      } catch {
        throw bad('Enter a valid link, e.g. https://example.com');
      }
    case 'options':
      if (!options.includes(v)) throw bad('Choose one of the options');
      return v;
    case 'boolean':
      if (v !== 'true' && v !== 'false') throw bad('Choose yes or no');
      return v;
    default:
      if (v.length > VALUE_MAX) throw bad(`Up to ${VALUE_MAX} characters`);
      return v;
  }
}

export async function customValuesOf(contactId: string) {
  const rows = await prisma.contactCustomValue.findMany({ where: { contactId }, select: { propertyId: true, value: true } });
  return rows;
}

const shown = (type: string, v: string | null) => (v === null ? null : type === 'boolean' ? (v === 'true' ? 'Yes' : 'No') : v);

// A contact's value for one custom property; everyone with the chat open sees it live, and the change is logged
export async function setCustomValue(auth: AuthPayload, contactId: string, propertyId: string, raw: string | null) {
  await getPermissions(auth);
  const contact = await requireContact(auth.workspaceId, contactId);
  const p = await requireProperty(auth.workspaceId, propertyId);
  const value = normalizeValue(p.type, optionsOf(p.options), raw ?? '');
  const where = { contactId_propertyId: { contactId, propertyId } };
  const before = (await prisma.contactCustomValue.findUnique({ where }))?.value ?? null;
  if (before !== value) {
    if (value === null) await prisma.contactCustomValue.delete({ where });
    else await prisma.contactCustomValue.upsert({ where, update: { value, updatedBy: auth.userId }, create: { contactId, propertyId, value, updatedBy: auth.userId } });
    const conversationId = await conversationOf(auth.workspaceId, contactId);
    if (conversationId)
      await recordActivity({
        workspaceId: auth.workspaceId,
        conversationId,
        actorId: auth.userId,
        type: 'contact_updated',
        data: { changes: [{ field: `custom:${p.key}`, label: p.name, from: shown(p.type, before), to: shown(p.type, value) }] },
      });
  }
  const customValues = await customValuesOf(contactId);
  emitToWorkspace(auth.workspaceId, 'contact:updated', { ...contact, customValues });
  return contact;
}
