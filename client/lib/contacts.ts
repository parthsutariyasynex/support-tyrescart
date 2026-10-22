import { gql } from './api';
import { currentTimeZone, formatDateTime } from './time';

// Customer profile for the chat side panel: "Contact property" fields and "Remarks" (internal notes).
// Every role can view and edit; remarks are deleted by their author or an owner/admin (the server checks).

export type ContactProfile = {
  id: string;
  waId: string;
  name: string | null; // WhatsApp profile name (updated by WhatsApp)
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  companyName: string | null;
  jobTitle: string | null;
  leadStage: string | null;
  leadSource: string | null;
  priority: string | null;
  country: string | null; // set by the team
  phoneCountry: string | null; // from the phone number's calling code
  subscribed: boolean;
  waBsuid: string | null;
  waUsername: string | null;
  lists: { id: string; name: string }[]; // contact lists this customer is in
  customValues?: CustomValue[]; // values of the workspace's custom properties (only the ones set)
  conversationId: string | null; // their chat (one per customer)
  createdAt: string;
  updatedAt: string;
};
export type ContactRemark = { id: string; contactId: string; body: string; createdById: string | null; authorName: string | null; createdAt: string; editedAt: string | null };
// Lead stages also carry their id, colour, whether they're a Lost stage (`closed`) and the default (new contacts)
export type ContactOption = { value: string; label: string; color?: string | null; closed?: boolean | null; id?: string | null; isDefault?: boolean | null };
export type ContactFieldOptions = { leadStages: ContactOption[]; leadSources: ContactOption[]; priorities: ContactOption[]; remarkMaxLength: number };
export type EditableField = 'firstName' | 'lastName' | 'email' | 'companyName' | 'jobTitle' | 'leadStage' | 'leadSource' | 'priority' | 'country' | 'subscribed';
// Chat details shown read-only in Contact property
export type ChatDetails = { channel: string; lastOutboundAt: string | null; lastInboundAt: string | null };

const FIELDS = 'id waId name firstName lastName email companyName jobTitle leadStage leadSource priority country phoneCountry subscribed waBsuid waUsername lists { id name } customValues { propertyId value } conversationId createdAt updatedAt';
const REMARK_FIELDS = 'id contactId body createdById authorName createdAt editedAt';

export async function fetchContact(id: string) {
  return (await gql<{ contact: ContactProfile }>(`query Contact($id: ID!) { contact(id: $id) { ${FIELDS} } }`, { id })).contact;
}
export async function updateContact(id: string, input: Partial<Record<EditableField, string | boolean>>) {
  return (await gql<{ updateContact: ContactProfile }>(`mutation UpdateContact($id: ID!, $i: ContactInput!) { updateContact(id: $id, input: $i) { ${FIELDS} } }`, { id, i: input })).updateContact;
}
export async function fetchRemarks(contactId: string) {
  return (await gql<{ contactRemarks: ContactRemark[] }>(`query Remarks($c: ID!) { contactRemarks(contactId: $c) { ${REMARK_FIELDS} } }`, { c: contactId })).contactRemarks;
}
export async function addRemark(contactId: string, body: string) {
  return (await gql<{ addContactRemark: ContactRemark }>(`mutation AddRemark($c: ID!, $b: String!) { addContactRemark(contactId: $c, body: $b) { ${REMARK_FIELDS} } }`, { c: contactId, b: body })).addContactRemark;
}
export async function updateRemark(id: string, body: string) {
  return (await gql<{ updateContactRemark: ContactRemark }>(`mutation UpdateRemark($id: ID!, $b: String!) { updateContactRemark(id: $id, body: $b) { ${REMARK_FIELDS} } }`, { id, b: body })).updateContactRemark;
}
export async function deleteRemark(id: string) {
  return (await gql<{ deleteContactRemark: boolean }>(`mutation DeleteRemark($id: ID!) { deleteContactRemark(id: $id) }`, { id })).deleteContactRemark;
}
export async function fetchChatDetails(conversationId: string) {
  return (await gql<{ conversation: ChatDetails }>(`query ChatDetails($id: ID!) { conversation(id: $id) { channel lastOutboundAt lastInboundAt } }`, { id: conversationId })).conversation;
}
let cachedOptions: ContactFieldOptions | null = null;
const STAGE_FIELDS = 'id value label color closed isDefault';
export async function fetchContactFieldOptions(fresh = false) {
  if (fresh) cachedOptions = null;
  cachedOptions ??= (
    await gql<{ contactFieldOptions: ContactFieldOptions }>(
      `{ contactFieldOptions { leadStages { ${STAGE_FIELDS} } leadSources { value label } priorities { value label } remarkMaxLength } }`,
    )
  ).contactFieldOptions;
  return cachedOptions;
}

// --- Lead stages (Settings → Customer lifecycle, admins). Changed here or by anyone (socket): every stage menu,
// pill and profile reloads them; `moved` = contacts moved off a deleted stage
export const LEAD_STAGES_EVENT = 'app:lead-stages';
export type StagesChanged = { moved?: { from: string; to: string | null } };
export function stagesChanged(detail: StagesChanged = {}) {
  cachedOptions = null;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(LEAD_STAGES_EVENT, { detail }));
}
const stagesMutation = async <K extends string>(name: K, query: string, variables: Record<string, unknown>) => {
  const r = (await gql<Record<K, ContactOption[]>>(query, variables))[name];
  stagesChanged();
  return r;
};
export const createLeadStage = (input: { label: string; color: string; lost: boolean }) =>
  stagesMutation('createLeadStage', `mutation CreateStage($i: LeadStageInput!) { createLeadStage(input: $i) { ${STAGE_FIELDS} } }`, { i: input });
export const updateLeadStage = (id: string, input: { label?: string; color?: string }) =>
  stagesMutation('updateLeadStage', `mutation UpdateStage($id: ID!, $i: LeadStageUpdate!) { updateLeadStage(id: $id, input: $i) { ${STAGE_FIELDS} } }`, { id, i: input });
export const reorderLeadStages = (progressing: string[], lost: string[]) =>
  stagesMutation('reorderLeadStages', `mutation ReorderStages($p: [ID!]!, $l: [ID!]!) { reorderLeadStages(progressing: $p, lost: $l) { ${STAGE_FIELDS} } }`, { p: progressing, l: lost });
export const setDefaultLeadStage = (id: string) =>
  stagesMutation('setDefaultLeadStage', `mutation DefaultStage($id: ID!) { setDefaultLeadStage(id: $id) { ${STAGE_FIELDS} } }`, { id });
export async function deleteLeadStage(id: string, from: string, moveTo: string | null) {
  const r = (
    await gql<{ deleteLeadStage: { stages: ContactOption[]; moved: number } }>(
      `mutation DeleteStage($id: ID!, $m: String) { deleteLeadStage(id: $id, moveTo: $m) { moved stages { ${STAGE_FIELDS} } } }`,
      { id, m: moveTo },
    )
  ).deleteLeadStage;
  stagesChanged({ moved: { from, to: moveTo } });
  return r;
}

export type ChatFile = {
  id: string;
  type: string;
  direction: 'in' | 'out';
  createdAt: string;
  mediaMime?: string | null;
  mediaName?: string | null;
  mediaSize?: number | null;
  available?: boolean; // the file can be opened
};
export async function fetchChatFiles(conversationId: string) {
  return (await gql<{ chatFiles: ChatFile[] }>(`query ChatFiles($c: ID!) { chatFiles(conversationId: $c) { id type direction createdAt mediaMime mediaName mediaSize available } }`, { c: conversationId })).chatFiles;
}

// --- Pure helpers (unit-tested)

// "Photo", "Voice message"... for the Attachments tab
const FILE_NAMES: Record<string, string> = { image: 'Photo', video: 'Video', audio: 'Audio', voice: 'Voice message', document: 'Document', sticker: 'Sticker' };
export const fileLabel = (type: string) => FILE_NAMES[type] ?? 'File';

// Attachments tab sections: Media (photos, videos, stickers, audio, voice) and Document; order kept (newest first)
export function splitFiles<F extends { type: string }>(files: F[]) {
  return { media: files.filter((f) => f.type !== 'document'), documents: files.filter((f) => f.type === 'document') };
}

// Name shown at the top of the panel: the team's first/last name if set, else the WhatsApp name, else the number
export function profileName(c: Pick<ContactProfile, 'firstName' | 'lastName' | 'name' | 'waId'>) {
  const full = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return full || c.name || `+${c.waId}`;
}

export type PropertyRow = {
  key: EditableField | 'phone' | 'owner' | 'channel' | 'lastFromYou' | 'lastFromCustomer' | 'waBsuid' | 'waUsername' | `custom:${string}`;
  label: string;
  value: string;
  editable: boolean;
  kind: 'text' | 'email' | 'select';
  options?: ContactOption[];
  // Custom properties (Settings → Contact properties → Add column)
  custom?: { id: string; type: string; key: string };
  inputType?: 'text' | 'number' | 'date' | 'url' | 'datetime-local' | 'multiline';
  originalLabel?: string; // a standard property's own name, when the workspace renamed it
};

// --- Custom properties: added by admins in Settings → Contact properties; their types come from the server
export type CustomProperty = { id: string; name: string; key: string; type: string; options: string[]; createdAt: string };
export type CustomValue = { propertyId: string; value: string };
// Added, renamed or removed (by anyone): reload them
export const CUSTOM_PROPERTIES_EVENT = 'app:contact-properties';
const CUSTOM_FIELDS = 'id name key type options createdAt';
let customCache: Promise<CustomProperty[]> | null = null;
export function fetchCustomProperties(fresh = false) {
  if (fresh || !customCache) {
    customCache = gql<{ customProperties: CustomProperty[] }>(`{ customProperties { ${CUSTOM_FIELDS} } }`).then((r) => r.customProperties);
    customCache.catch(() => (customCache = null));
  }
  return customCache;
}
let typesCache: Promise<ContactOption[]> | null = null;
export function fetchCustomPropertyTypes() {
  typesCache ??= gql<{ customPropertyTypes: ContactOption[] }>(`{ customPropertyTypes { value label } }`).then((r) => r.customPropertyTypes);
  typesCache.catch(() => (typesCache = null));
  return typesCache;
}
const customChanged = <T,>(v: T) => {
  customCache = null;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CUSTOM_PROPERTIES_EVENT));
  return v;
};
export async function createCustomProperty(input: { name: string; type: string; options?: string[] }) {
  return customChanged(
    (await gql<{ createCustomProperty: CustomProperty }>(`mutation CreateProp($i: CustomPropertyInput!) { createCustomProperty(input: $i) { ${CUSTOM_FIELDS} } }`, { i: input }))
      .createCustomProperty,
  );
}
export async function updateCustomProperty(id: string, input: { name?: string; options?: string[] }) {
  return customChanged(
    (await gql<{ updateCustomProperty: CustomProperty }>(`mutation UpdateProp($id: ID!, $i: CustomPropertyUpdate!) { updateCustomProperty(id: $id, input: $i) { ${CUSTOM_FIELDS} } }`, { id, i: input }))
      .updateCustomProperty,
  );
}
export async function deleteCustomProperty(id: string) {
  await gql(`mutation DeleteProp($id: ID!) { deleteCustomProperty(id: $id) }`, { id });
  customChanged(null);
}
export async function setCustomValue(contactId: string, propertyId: string, value: string) {
  return (
    await gql<{ setContactCustomValue: ContactProfile }>(`mutation SetValue($c: ID!, $p: ID!, $v: String) { setContactCustomValue(contactId: $c, propertyId: $p, value: $v) { ${FIELDS} } }`, {
      c: contactId,
      p: propertyId,
      v: value,
    })
  ).setContactCustomValue;
}

// The key a new property gets, shown while typing its name (the server makes the same one): "Tyre size" → tyre_size
export function propertyKey(name: string) {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, 40)
    .replace(/_+$/, '');
}

// One row per custom property, after the standard ones
export function customRows(c: Pick<ContactProfile, 'customValues'>, custom: CustomProperty[]): PropertyRow[] {
  return custom.map((p) => {
    const value = c.customValues?.find((v) => v.propertyId === p.id)?.value ?? '';
    const base = { key: `custom:${p.key}` as const, label: p.name, value, editable: true, custom: { id: p.id, type: p.type, key: p.key } };
    if (p.type === 'options') return { ...base, kind: 'select', options: p.options.map((o) => ({ value: o, label: o })) };
    if (p.type === 'boolean') return { ...base, kind: 'select', options: YES_NO };
    if (p.type === 'email') return { ...base, kind: 'email' };
    const inputType = ({ number: 'number', date: 'date', url: 'url', datetime: 'datetime-local', multiline: 'multiline' } as const)[p.type as 'number'] ?? 'text';
    return { ...base, kind: 'text', inputType };
  });
}

// Standard properties renamed for the workspace (Settings → Contact properties → edit)
export function withLabels(rows: PropertyRow[], labels: { key: string; name: string }[] | undefined) {
  if (!labels?.length) return rows;
  return rows.map((r) => {
    const name = labels.find((l) => l.key === r.key)?.name;
    return name ? { ...r, label: name, originalLabel: r.label } : r;
  });
}
export const YES_NO: ContactOption[] = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

// The "Contact property" list, in the order shown. First name falls back to the WhatsApp name and country to the
// phone number's country until they are set. Chat details (channel, last contact times) are read-only.
export function propertyRows(c: ContactProfile, owner: string | null, opts: ContactFieldOptions | null, chat: ChatDetails | null = null): PropertyRow[] {
  const when = (iso: string | null | undefined) => (iso ? formatDateTime(iso) : '');
  return [
    { key: 'firstName', label: 'First name', value: c.firstName ?? c.name ?? '', editable: true, kind: 'text' },
    { key: 'lastName', label: 'Last name', value: c.lastName ?? '', editable: true, kind: 'text' },
    { key: 'email', label: 'Email', value: c.email ?? '', editable: true, kind: 'email' },
    { key: 'phone', label: 'Phone number', value: `+${c.waId}`, editable: false, kind: 'text' },
    { key: 'companyName', label: 'Company name', value: c.companyName ?? '', editable: true, kind: 'text' },
    { key: 'jobTitle', label: 'Job title', value: c.jobTitle ?? '', editable: true, kind: 'text' },
    { key: 'owner', label: 'Contact owner', value: owner ?? '', editable: false, kind: 'text' },
    { key: 'leadStage', label: 'Lead stage', value: c.leadStage ?? '', editable: true, kind: 'select', options: opts?.leadStages ?? [] },
    { key: 'leadSource', label: 'Lead source', value: c.leadSource ?? '', editable: true, kind: 'select', options: opts?.leadSources ?? [] },
    { key: 'priority', label: 'Priority', value: c.priority ?? '', editable: true, kind: 'select', options: opts?.priorities ?? [] },
    { key: 'country', label: 'Country', value: c.country ?? c.phoneCountry ?? '', editable: true, kind: 'text' },
    { key: 'subscribed', label: 'Subscriber', value: String(c.subscribed ?? true), editable: true, kind: 'select', options: YES_NO },
    { key: 'channel', label: 'Last channel', value: chat?.channel ?? '', editable: false, kind: 'text' },
    { key: 'lastFromYou', label: 'Last contact from you', value: when(chat?.lastOutboundAt), editable: false, kind: 'text' },
    { key: 'lastFromCustomer', label: 'Last contact from customer', value: when(chat?.lastInboundAt), editable: false, kind: 'text' },
    { key: 'waBsuid', label: 'WhatsApp BSUID', value: c.waBsuid ?? '', editable: false, kind: 'text' },
    { key: 'waUsername', label: 'WhatsApp username', value: c.waUsername ?? '', editable: false, kind: 'text' },
  ];
}

// What a row shows: the option's label for dropdowns, the text otherwise; '–' when empty
export function displayValue(row: Pick<PropertyRow, 'value' | 'options' | 'kind' | 'inputType'>) {
  if (!row.value) return '–';
  if (row.kind === 'select') return row.options?.find((o) => o.value === row.value)?.label ?? row.value;
  if (row.inputType === 'datetime-local') return row.value.replace('T', ' '); // 2026-10-16 14:30
  return row.value;
}

// Property search: matches the field name or its value
export function filterRows(rows: PropertyRow[], query: string) {
  const term = query.trim().toLowerCase();
  if (!term) return rows;
  return rows.filter((r) => r.label.toLowerCase().includes(term) || displayValue(r).toLowerCase().includes(term));
}

// --- Stripe payment status (profile panel, Orders tab)
// Stripe isn't connected to the app yet, so there are no payments to show; the filter and search below are what
// the section uses once payments come in.
export type Payment = { id: string; amount: number; currency: string; status: string; description: string | null; createdAt: string };
export const PAYMENT_FILTERS = [
  { value: 'all', label: 'All latest payments' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'pending', label: 'Pending' },
  { value: 'failed', label: 'Failed' },
  { value: 'refunded', label: 'Refunded' },
] as const;

// Status dropdown + search (payment id, description, amount), newest first
export function filterPayments(payments: Payment[], status: string, query: string) {
  const term = query.trim().toLowerCase();
  return payments
    .filter((p) => status === 'all' || p.status === status)
    .filter((p) => !term || [p.id, p.description ?? '', (p.amount / 100).toFixed(2), p.currency].some((v) => v.toLowerCase().includes(term)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// --- Contact property view: the workspace's default view (admins set it in Settings → Contact properties) or
// your own personal view; both saved on the server.
export type PropertyView = { personal: boolean; order: string[]; hidden: string[]; defaultOrder: string[]; defaultHidden: string[]; labels?: { key: string; name: string }[] };
export const DEFAULT_VIEW: PropertyView = { personal: false, order: [], hidden: [], defaultOrder: [], defaultHidden: [], labels: [] };
// Settings changed a view: open profile panels reload theirs
export const PROPERTY_VIEW_EVENT = 'app:property-view-changed';
const VIEW_FIELDS = 'personal order hidden defaultOrder defaultHidden labels { key name }';
const viewChanged = <T,>(v: T) => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PROPERTY_VIEW_EVENT));
  return v;
};
export async function fetchPropertyView() {
  return (await gql<{ myPropertyView: PropertyView }>(`{ myPropertyView { ${VIEW_FIELDS} } }`)).myPropertyView;
}
export async function savePropertyView(view: Pick<PropertyView, 'personal' | 'order' | 'hidden'>) {
  const { personal, order, hidden } = view;
  return viewChanged(
    (await gql<{ savePropertyView: PropertyView }>(`mutation SaveView($i: PropertyViewInput!) { savePropertyView(input: $i) { ${VIEW_FIELDS} } }`, { i: { personal, order, hidden } }))
      .savePropertyView,
  );
}
export async function saveDefaultPropertyView(view: { order: string[]; hidden: string[] }) {
  return viewChanged(
    (await gql<{ saveDefaultPropertyView: PropertyView }>(`mutation SaveDefaultView($i: DefaultPropertyViewInput!) { saveDefaultPropertyView(input: $i) { ${VIEW_FIELDS} } }`, { i: view }))
      .saveDefaultPropertyView,
  );
}

export async function renameStandardProperty(key: string, name: string) {
  return viewChanged(
    (await gql<{ renameStandardProperty: PropertyView }>(`mutation Rename($k: String!, $n: String!) { renameStandardProperty(key: $k, name: $n) { ${VIEW_FIELDS} } }`, { k: key, n: name }))
      .renameStandardProperty,
  );
}

// "Property type" in Settings → Contact properties, named as in SleekFlow (custom ones: the type's name from the
// server, the same names)
export function propertyTypeLabel(row: Pick<PropertyRow, 'key' | 'kind' | 'custom'>, types: ContactOption[] = []) {
  if (row.custom) return types.find((t) => t.value === row.custom!.type)?.label ?? row.custom.type;
  if (row.key === 'subscribed') return 'Boolean';
  if (row.key === 'phone') return 'PhoneNumber';
  if (row.key === 'owner') return 'User';
  if (row.key === 'lastFromYou' || row.key === 'lastFromCustomer') return 'DateTime';
  if (row.kind === 'select') return 'Options';
  if (row.kind === 'email') return 'Email';
  return 'SingleLineText';
}

// Keys in a view's order: the ones placed (in that order), then any others in the standard order (e.g. a property
// added later), so nothing is lost
export function orderKeys(allKeys: string[], order: string[]) {
  const known = order.filter((k) => allKeys.includes(k));
  return [...known, ...allKeys.filter((k) => !known.includes(k))];
}

// The rows as your view shows them: the workspace default view, or your personal view; hidden ones left out
export function applyView<R extends { key: string }>(rows: R[], view: PropertyView) {
  const order = view.personal ? view.order : (view.defaultOrder ?? []);
  const hidden = view.personal ? view.hidden : (view.defaultHidden ?? []);
  const keys = orderKeys(rows.map((r) => r.key), order);
  return keys.map((k) => rows.find((r) => r.key === k)!).filter((r) => !hidden.includes(r.key));
}

// --- Contact details page: activity log and "Activity" facts

export type ActivityKind = 'user' | 'customer' | 'system';
export const ACTIVITY_FILTERS = [
  { value: 'all', label: 'All activities' },
  { value: 'user', label: 'User activities' },
  { value: 'customer', label: 'Customer messages' },
  { value: 'system', label: 'System activities' },
] as const;

// Who an entry came from: a teammate (has an actor), the customer (a received message), or the app itself
export function activityKind(a: { type: string; actorId: string | null }): ActivityKind {
  if (a.type === 'message_received') return 'customer';
  return a.actorId ? 'user' : 'system';
}

// Newest first, grouped by month ("October 2026"), in the app time zone
export function groupByMonth<A extends { createdAt: string }>(items: A[], locale = 'en-GB') {
  const fmt = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: currentTimeZone() });
  const groups: { month: string; items: A[] }[] = [];
  for (const a of [...items].sort((x, y) => y.createdAt.localeCompare(x.createdAt))) {
    const month = fmt.format(new Date(a.createdAt));
    const last = groups[groups.length - 1];
    if (last?.month === month) last.items.push(a);
    else groups.push({ month, items: [a] });
  }
  return groups;
}

// "just now", "5 minutes ago", "2 days ago", "3 months ago"
export function timeAgo(iso: string, now = Date.now()) {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  const n = (v: number, unit: string) => `${v} ${unit}${v === 1 ? '' : 's'} ago`;
  if (s < 60) return 'just now';
  if (s < 3600) return n(Math.floor(s / 60), 'minute');
  if (s < 86400) return n(Math.floor(s / 3600), 'hour');
  if (s < 86400 * 30) return n(Math.floor(s / 86400), 'day');
  if (s < 86400 * 365) return n(Math.floor(s / (86400 * 30)), 'month');
  return n(Math.floor(s / (86400 * 365)), 'year');
}

// "Joined Oct 2026"
export const joinedText = (iso: string, locale = 'en-GB') =>
  `Joined ${new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: currentTimeZone() }).format(new Date(iso))}`;

// Contact details page: this customer's full history, newest first
export async function fetchContactActivity(contactId: string) {
  const q = `query ContactActivity($c: ID!) { contactActivity(contactId: $c) { id type conversationId actorId actorName contactName data createdAt } }`;
  return (await gql<{ contactActivity: import('./activity').Activity[] }>(q, { c: contactId })).contactActivity;
}

// One activity card: a bold title ("Conversation status changed by Satya Kumar") and detail lines
// ("Conversation status: [Closed] to [Open]"). Names come from the record (who did it), never "You".
export function activityCard(a: { type: string; actorName: string | null; contactName: string | null; data: string | null }) {
  let d: Record<string, any> = {};
  try {
    d = a.data ? JSON.parse(a.data) : {};
  } catch {
    d = {};
  }
  const by = a.actorName ? ` by ${a.actorName}` : '';
  const v = (x: unknown) => `[${x === null || x === undefined || x === '' ? '–' : String(x)}]`;
  switch (a.type) {
    case 'conversation_closed':
      return { title: `Conversation status changed${by}`, lines: [`Conversation status: [Open] to [Closed]`] };
    case 'conversation_reopened': {
      const from = d.reason === 'snooze_ended' || d.reason === 'customer_replied' ? 'Snoozed' : 'Closed';
      const why = d.reason === 'snooze_ended' ? ' (snooze ended)' : d.reason === 'customer_replied' ? ' (the customer replied)' : '';
      return { title: `Conversation status changed${by}`, lines: [`Conversation status: [${from}] to [Open]${why}`] };
    }
    case 'conversation_snoozed':
      return { title: `Conversation snoozed${by}`, lines: [`Conversation status: [Open] to [Snoozed]`] };
    case 'assigned':
      return { title: `Conversation assigned${by}`, lines: [`Assignee: [Unassigned] to ${v(d.assignee)}`] };
    case 'reassigned':
      return { title: `Conversation reassigned${by}`, lines: [`Assignee: ${v(d.previous)} to ${v(d.assignee)}`] };
    case 'unassigned':
      return { title: `Conversation unassigned${by}`, lines: [`Assignee: ${v(d.assignee)} to [Unassigned]`] };
    case 'label_added':
      return { title: `Label added${by}`, lines: [`Label: ${v(d.label)}`] };
    case 'label_removed':
      return { title: `Label removed${by}`, lines: [`Label: ${v(d.label)}`] };
    case 'collaborators_added':
      return { title: `Collaborators added${by}`, lines: [`Added: ${v((d.names ?? []).join(', '))}`] };
    case 'collaborator_removed':
      return { title: `Collaborator removed${by}`, lines: [`Removed: ${v(d.name)}`] };
    case 'message_edited':
      return { title: `Message edited${by}`, lines: [] };
    case 'message_deleted':
      return { title: `Message deleted${by}`, lines: [] };
    case 'message_restored':
      return { title: `Message restored${by}`, lines: [] };
    case 'message_received':
      return { title: `Message from ${a.contactName ?? 'the customer'}`, lines: d.preview ? [String(d.preview)] : [] };
    case 'contact_updated':
      return {
        title: `Fields changed${by}`,
        lines: ['Profile information updated:', ...((d.changes ?? []) as { label: string; from: unknown; to: unknown }[]).map((c) => `${c.label}: ${v(c.from)} to ${v(c.to)}`)],
      };
    case 'message_sent':
      return {
        title: `Message sent${by}`,
        lines: [d.preview ? String(d.preview) : '', d.status === 'failed' ? 'Not delivered' : ''].filter(Boolean),
      };
    case 'list_added':
      return { title: `Added to list${by}`, lines: [`List: ${v(d.list)}`] };
    case 'list_removed':
      return { title: `Removed from list${by}`, lines: [`List: ${v(d.list)}${d.reason === 'list_deleted' ? ' (the list was deleted)' : ''}`] };
    case 'remark_added':
      return { title: `Manual log${by}`, lines: d.text ? [String(d.text)] : [] };
    case 'remark_edited':
      return { title: `Manual log edited${by}`, lines: d.text ? [String(d.text)] : [] };
    case 'remark_deleted':
      return { title: `Manual log deleted${by}`, lines: d.text ? [String(d.text)] : [] };
    default:
      return { title: `Conversation updated${by}`, lines: [] };
  }
}

// Contact details page "Media": filter by type, sort by date
export const MEDIA_FILTERS = [
  { value: 'all', label: 'All types' },
  { value: 'image', label: 'Image' }, // photos and stickers
  { value: 'video', label: 'Video' },
  { value: 'audio', label: 'Audio' }, // audio files and voice messages
  { value: 'document', label: 'Document' },
] as const;
export const MEDIA_SORTS = [
  { value: 'latest', label: 'Latest' },
  { value: 'oldest', label: 'Earliest' },
] as const;
const MEDIA_GROUP: Record<string, string> = { sticker: 'image', voice: 'audio' };
export function filterSortFiles<F extends { type: string; createdAt: string }>(files: F[], type: string, sort: string) {
  const shown = files.filter((f) => type === 'all' || (MEDIA_GROUP[f.type] ?? f.type) === type);
  return [...shown].sort((a, b) => (sort === 'oldest' ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt)));
}

// The chat header's › button: the next lead stage. No stage → the first one; through the open stages in order;
// after the last open stage → the first closed one (Won). A closed stage (Won, Lost) has no next.
// The › button: the next progressing stage (none after the last one, none from a Lost stage); no stage yet → the first
export function nextStage<S extends { value: string; closed?: boolean | null }>(stages: S[], current: string | null | undefined) {
  const progressing = stages.filter((s) => !s.closed);
  if (!progressing.length) return null;
  if (!current) return progressing[0];
  const stage = stages.find((s) => s.value === current);
  if (!stage) return progressing[0];
  if (stage.closed) return null;
  return progressing[progressing.indexOf(stage) + 1] ?? null;
}

// Settings → Customer lifecycle: contacts per lead stage (stage null = no stage set). chats: the left menu's
// counts instead, the chats each stage link lists (contacts with a chat, not deleted)
export async function fetchLeadStageCounts(chats = false) {
  return (
    await gql<{ leadStageCounts: { stage: string | null; count: number }[] }>(`query StageCounts($c: Boolean) { leadStageCounts(chats: $c) { stage count } }`, { c: chats })
  ).leadStageCounts;
}

// Something that changes the stage counts happened (a new chat, a stage changed, a contact deleted or restored)
export const STAGE_COUNTS_EVENT = 'app:stage-counts';

// --- Deleting contacts (admins): kept for a while in Settings → Recently deleted contacts, then removed for good
export type DeletedContact = {
  id: string;
  waId: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  deletedAt: string;
  deletedByName: string | null;
  purgeAt: string;
};
export async function deleteContact(id: string) {
  await gql(`mutation DeleteContact($id: ID!) { deleteContact(id: $id) }`, { id });
}
export async function restoreContact(id: string) {
  await gql(`mutation RestoreContact($id: ID!) { restoreContact(id: $id) }`, { id });
}
export async function fetchDeletedContacts() {
  return gql<{ deletedContacts: DeletedContact[]; deletedContactsRetentionDays: number }>(
    `{ deletedContacts { id waId name firstName lastName email deletedAt deletedByName purgeAt } deletedContactsRetentionDays }`,
  );
}
// Whole days left before it goes for good (0 = today)
export const daysLeft = (purgeAt: string, now = Date.now()) => Math.max(0, Math.ceil((new Date(purgeAt).getTime() - now) / 86_400_000));

// --- Lead source and Priority choices per workspace (Settings → Contact properties → edit; admins)
export type ChoiceField = 'leadSource' | 'priority';
export const CHOICE_FIELDS: ChoiceField[] = ['leadSource', 'priority'];
export async function saveFieldChoices(field: ChoiceField, choices: { value?: string | null; label: string }[]) {
  const r = (
    await gql<{ saveFieldChoices: { choices: ContactOption[]; cleared: number } }>(
      `mutation SaveChoices($f: String!, $c: [FieldChoiceInput!]!) { saveFieldChoices(field: $f, choices: $c) { cleared choices { value label } } }`,
      { f: field, c: choices.map((c) => ({ value: c.value ?? null, label: c.label })) },
    )
  ).saveFieldChoices;
  stagesChanged(); // every open profile and dropdown reloads the options
  return r;
}
export async function fetchFieldChoiceCounts(field: ChoiceField) {
  return (await gql<{ fieldChoiceCounts: { value: string | null; count: number }[] }>(`query ChoiceCounts($f: String!) { fieldChoiceCounts(field: $f) { value count } }`, { f: field })).fieldChoiceCounts;
}
