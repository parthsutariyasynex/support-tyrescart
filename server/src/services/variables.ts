import { prisma } from '../prisma.js';
import { STANDARD_PROPERTY_KEYS, phoneCountry, standardPropertyLabels } from './contacts.js';
import { choicesOf } from './fieldChoices.js';
import { listLeadStages } from './leadStages.js';

// Variables in automatic replies ({{contact.first_name}}, {{contact.tyre_size}}, {{company.name}} …), built from
// the workspace's own data model: the standard contact properties (with the names the workspace gave them), its
// custom properties, and the company's details. Values come from the customer's record, so nothing is made up:
// an empty field is left empty (except first and last name, which fall back to the WhatsApp name: see nameParts).
// A short form ({{first_name}}) works when exactly one variable ends with that name.

export type Variable = { key: string; label: string };

// First and last name: what's entered on the contact; when empty, taken from the WhatsApp profile name ("Alice
// Patel" → Alice, Patel). A one-word profile name has no last name (''); first name ends with "there" when nothing
// is known.
export function nameParts(c: { firstName?: string | null; lastName?: string | null; name?: string | null }) {
  const words = c.name?.trim().split(/\s+/).filter(Boolean) ?? [];
  return { first: c.firstName?.trim() || words[0] || 'there', last: c.lastName?.trim() || words.slice(1).join(' ') };
}

// Standard properties that describe the customer (chat details such as "last channel" aren't variables). Read
// when needed, not at load time: contacts.ts and this module import each other indirectly.
const contactKeys = () => STANDARD_PROPERTY_KEYS.filter((k) => !['channel', 'lastFromYou', 'lastFromCustomer', 'waBsuid'].includes(k));
const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
// "first_name" → "First name" (used when the workspace hasn't named the property)
const words = (key: string) => {
  const s = key.replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// Every variable a reply in this workspace can use, in the order the profile panel lists the properties
export async function listVariables(workspaceId: string): Promise<Variable[]> {
  const [renamed, custom] = await Promise.all([
    standardPropertyLabels(workspaceId),
    prisma.contactCustomProperty.findMany({ where: { workspaceId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { key: true, name: true } }),
  ]);
  const label = (k: string) => renamed.find((l) => l.key === k)?.name ?? words(snake(k));
  const contact: Variable[] = contactKeys().flatMap((k) => {
    const v = { key: `contact.${snake(k)}`, label: label(k) };
    // the full name sits after the last name (as before), so replies can use either
    return k === 'lastName' ? [v, { key: 'contact.name', label: 'Full name' }] : [v];
  });
  return [
    ...contact,
    ...custom.filter((p) => !contact.some((c) => c.key === `contact.${p.key}`)).map((p) => ({ key: `contact.${p.key}`, label: p.name })),
    { key: 'company.name', label: 'Company name' },
    { key: 'company.phone', label: 'Company WhatsApp number' },
  ];
}

// The values for one chat's customer (and the company), as the app shows them
export async function variableValues(workspaceId: string, conversationId: string): Promise<Record<string, string>> {
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    include: { contact: true, workspace: { select: { name: true, whatsapp: { select: { displayPhone: true } } } }, assignedTo: { include: { user: { select: { name: true } } } } },
  });
  if (!conv) return {};
  const c = conv.contact;
  const [stages, sources, priorities, props, custom] = await Promise.all([
    c.leadStage ? listLeadStages(workspaceId) : [],
    c.leadSource ? choicesOf(workspaceId, 'leadSource') : [],
    c.priority ? choicesOf(workspaceId, 'priority') : [],
    prisma.contactCustomProperty.findMany({ where: { workspaceId }, select: { id: true, key: true, type: true } }),
    prisma.contactCustomValue.findMany({ where: { contactId: c.id }, select: { propertyId: true, value: true } }),
  ]);
  const labelOf = (list: { value: string; label: string }[], v: string | null) => (v ? (list.find((o) => o.value === v)?.label ?? v) : '');
  const { first, last } = nameParts(c);
  const values: Record<string, string> = {
    'contact.first_name': first,
    'contact.last_name': last,
    'contact.name': [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || c.name?.trim() || first,
    'contact.email': c.email ?? '',
    'contact.phone': `+${c.waId}`,
    'contact.company_name': c.companyName ?? '',
    'contact.job_title': c.jobTitle ?? '',
    'contact.owner': conv.assignedTo?.user.name ?? '',
    'contact.lead_stage': labelOf(stages, c.leadStage),
    'contact.lead_source': labelOf(sources, c.leadSource),
    'contact.priority': labelOf(priorities, c.priority),
    'contact.country': c.country ?? phoneCountry(c.waId) ?? '',
    'contact.subscribed': c.subscribed ? 'Yes' : 'No',
    'contact.wa_username': c.waUsername ?? '',
    'company.name': conv.workspace.name,
    'company.phone': conv.workspace.whatsapp?.displayPhone ?? '',
  };
  for (const p of props) {
    if (values[`contact.${p.key}`] !== undefined) continue; // a standard property wins over a same-named custom one
    const raw = custom.find((v) => v.propertyId === p.id)?.value ?? '';
    values[`contact.${p.key}`] = p.type === 'boolean' && raw ? (raw === 'true' ? 'Yes' : 'No') : p.type === 'datetime' ? raw.replace('T', ' ') : raw;
  }
  return values;
}

const VAR_RE = /\{\{\s*([a-z0-9_.]+)\s*\}\}/gi;
// The variables used in a text, in order
export const variablesIn = (text: string) => [...new Set([...text.matchAll(VAR_RE)].map((m) => m[1].toLowerCase()))];

// A short form ({{first_name}}) → its full key, when exactly one variable ends with it
export function resolveKey(key: string, known: string[]) {
  const k = key.toLowerCase();
  if (known.includes(k)) return k;
  const matches = known.filter((full) => full.endsWith(`.${k}`));
  return matches.length === 1 ? matches[0] : null;
}

// The text with the values in; anything unknown is left out (and tidied: no double spaces)
export function fillVariables(text: string, values: Record<string, string>) {
  const known = Object.keys(values);
  return text
    .replace(VAR_RE, (_, key: string) => {
      const full = resolveKey(key, known);
      return full ? values[full] : '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
