import { API_URL, getToken, gql } from './api';
import type { Message } from './inbox';

// WhatsApp message templates: sending one with its values from a chat, and managing the number's templates
// (Settings → Templates). Templates live at Meta; the server checks everything again.

export type TemplateHeader = { format: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION'; text: string; variables: string[] };
export type TemplateButton = { type: string; text: string; url?: string | null; phoneNumber?: string | null; variables: string[] };
export type Template = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  rejectedReason: string | null;
  parameterFormat: string;
  header: TemplateHeader | null;
  body: string;
  bodyVariables: string[];
  footer: string | null;
  buttons: TemplateButton[];
  needsParameters: boolean;
  sendable: boolean;
  unsupportedReason: string | null;
};
export type TemplateValues = { header: Record<string, string>; body: Record<string, string>; buttons: Record<string, string> };

const FIELDS = `id name language category status rejectedReason parameterFormat header { format text variables } body bodyVariables footer
  buttons { type text url phoneNumber variables } needsParameters sendable unsupportedReason`;
const MESSAGE_FIELDS =
  'id conversationId direction type body status error createdAt sentById senderName editedAt deletedAt version mediaMime mediaSize mediaName customerReaction teamReaction teamReactionById automation';

// Meta's sample template, added to every WhatsApp Business account by Meta (not one of ours); the server leaves it
// out too
export const META_SAMPLE_TEMPLATES: readonly string[] = ['hello_world'];
// What the chat's template list offers: the account's approved templates only, never Meta's sample. The server
// already sends only these; checked here again so nothing else can show up
export const chatTemplates = <T extends Pick<Template, 'name' | 'status'>>(list: T[]) => list.filter((t) => t.status === 'APPROVED' && !META_SAMPLE_TEMPLATES.includes(t.name));

// The account's approved templates, read live from Meta through the server (Send template / Template)
export async function fetchApprovedTemplates() {
  return chatTemplates((await gql<{ messageTemplates: Template[] }>(`query Templates { messageTemplates { ${FIELDS} } }`)).messageTemplates);
}
export async function fetchAllTemplates() {
  return (await gql<{ allMessageTemplates: Template[] }>(`query AllTemplates { allMessageTemplates { ${FIELDS} } }`)).allMessageTemplates;
}
export async function fetchEditorInfo() {
  return (await gql<{ templateEditorInfo: { languages: { value: string; label: string }[]; mediaHeaderAvailable: boolean } }>(
    `{ templateEditorInfo { languages { value label } mediaHeaderAvailable } }`,
  )).templateEditorInfo;
}

const mediaHeader = (t: Pick<Template, 'header'>) => (t.header && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(t.header.format) ? t.header.format : null);

// Send from a chat, only after the agent's "Yes, Send": a header file goes to the upload route, everything else
// through GraphQL. requestId is made once per confirmation, so a repeated request can't send it twice.
export async function sendTemplate(conversationId: string, t: Template, values: TemplateValues, file: File | null | undefined, requestId: string): Promise<Message> {
  if (mediaHeader(t)) {
    if (!file) throw new Error(`Choose the header ${mediaHeader(t)!.toLowerCase()}`);
    const q = new URLSearchParams({ name: t.name, language: t.language, values: JSON.stringify(values), fileName: file.name, confirmed: 'true', requestId });
    const res = await fetch(`${API_URL}/inbox/conversations/${encodeURIComponent(conversationId)}/template?${q}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken() ?? ''}`, 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Couldn't send the template (${res.status})`);
    return data as Message;
  }
  return (
    await gql<{ sendTemplateMessage: Message }>(`mutation SendTemplate($input: SendTemplateInput!) { sendTemplateMessage(input: $input) { ${MESSAGE_FIELDS} } }`, {
      input: { conversationId, name: t.name, language: t.language, values: JSON.stringify(values), confirmed: true, requestId },
    })
  ).sendTemplateMessage;
}

// --- Preview and values

const VAR_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
export function variablesOf(text: string | null | undefined) {
  const out: string[] = [];
  for (const m of (text ?? '').matchAll(VAR_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
// Text with the values in; an empty value shows as {{n}} (the preview marks it)
export type Piece = { text: string; variable?: string; filled?: boolean };
export function fillPieces(text: string, values: Record<string, string>): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const m of text.matchAll(VAR_RE)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index) });
    const v = values[m[1]]?.trim();
    out.push({ text: v || `{{${m[1]}}}`, variable: m[1], filled: !!v });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
// The customer's first and last name for a template, by the same rule the server uses for variables: what's saved
// on the contact, else the WhatsApp profile name ("Alice Patel" → Alice, Patel). '' when unknown: the field is then
// left for the agent to fill in (WhatsApp refuses empty values, so nothing is guessed).
export function customerNames(c: { firstName?: string | null; lastName?: string | null; name?: string | null }) {
  const words = c.name?.trim().split(/\s+/).filter(Boolean) ?? [];
  return { first: c.firstName?.trim() || words[0] || '', last: c.lastName?.trim() || words.slice(1).join(' ') };
}

// Which body variable gets which name: {{1}} the first name and {{2}} the last name (named templates: first_name /
// last_name). null for any other variable (filled in by hand).
export function nameFor(variable: string): 'first' | 'last' | null {
  if (variable === '1' || /^first_?name$/i.test(variable)) return 'first';
  if (variable === '2' || /^last_?name$/i.test(variable)) return 'last';
  return null;
}

// A name the customer doesn't have: WhatsApp refuses an empty value, so the variable gets this invisible character
// instead (a zero-width space). The customer reads "Hello 👋, …": no made-up name, the approved template unchanged.
export const NO_NAME = '\u200B';

// Body values filled in from the customer's names; a name that isn't known is NO_NAME
export function autoFillValues(t: Pick<Template, 'bodyVariables'>, names: { first: string; last: string }): TemplateValues {
  const body: Record<string, string> = {};
  for (const v of t.bodyVariables) {
    const which = nameFor(v);
    if (which) body[v] = names[which] || NO_NAME;
  }
  return { header: {}, body, buttons: {} };
}

// The message as the customer will read it: the values filled in, and a variable with no value (or NO_NAME) left
// out together with its extra space ("Hello {{1}} 👋," with no name → "Hello 👋,"), never shown as {{1}}.
export function readableMessage(text: string, values: Record<string, string>) {
  return text
    .replace(VAR_RE, (_, v: string) => (values[v] ?? '').replaceAll(NO_NAME, '').trim())
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.!?;:])/g, '$1')
    .replace(/^[ \t]+|[ \t]+$/gm, '');
}

// What still has to be filled in before sending (and the header file)
export function missingValues(t: Template, values: TemplateValues, file?: File | null) {
  const missing: string[] = [];
  if (mediaHeader(t) && !file) missing.push(`header ${mediaHeader(t)!.toLowerCase()}`);
  for (const v of t.header?.format === 'TEXT' ? t.header.variables : []) if (!values.header[v]?.trim()) missing.push(`header {{${v}}}`);
  for (const v of t.bodyVariables) if (!values.body[v]?.trim()) missing.push(`{{${v}}}`);
  t.buttons.forEach((b, i) => {
    if ((b.type === 'URL' && b.variables.length) || b.type === 'COPY_CODE') if (!values.buttons[String(i)]?.trim()) missing.push(b.type === 'COPY_CODE' ? 'coupon code' : `link for “${b.text}”`);
  });
  return missing;
}

// --- Settings → Templates: the editor

export type ButtonSpec =
  | { type: 'QUICK_REPLY'; text: string }
  | { type: 'URL'; text: string; url: string; example?: string }
  | { type: 'PHONE_NUMBER'; text: string; phoneNumber: string }
  | { type: 'COPY_CODE'; example: string };
export type TemplateSpec = {
  name: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  language: string;
  header: { format: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT'; text?: string; example?: string } | null;
  body: string;
  bodyExamples: string[];
  footer: string;
  buttons: ButtonSpec[];
  securityRecommendation: boolean;
  codeExpirationMinutes: number | null;
};
export const EMPTY_SPEC: TemplateSpec = {
  name: '',
  category: 'UTILITY',
  language: 'en',
  header: null,
  body: '',
  bodyExamples: [],
  footer: '',
  buttons: [],
  securityRecommendation: true,
  codeExpirationMinutes: null,
};

// "Order Ready!" → order_ready (Meta's naming rule), as you type
export const templateName = (raw: string) =>
  raw
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 512);
// The next numbered variable for the body ({{1}}, {{2}}, …)
export const nextVariable = (body: string) => `{{${variablesOf(body).filter((v) => /^\d+$/.test(v)).length + 1}}}`;

// An existing template as the editor's starting point (sample values aren't returned by Meta: entered again)
export function specOf(t: Template): TemplateSpec {
  const vars = t.bodyVariables.length;
  return {
    name: t.name,
    category: (['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(t.category) ? t.category : 'UTILITY') as TemplateSpec['category'],
    language: t.language,
    header: t.header && t.header.format !== 'LOCATION' ? { format: t.header.format, ...(t.header.format === 'TEXT' ? { text: t.header.text, example: '' } : {}) } : null,
    body: t.body,
    bodyExamples: Array.from({ length: vars }, () => ''),
    footer: t.footer ?? '',
    buttons: t.buttons.flatMap((b): ButtonSpec[] => {
      if (b.type === 'QUICK_REPLY') return [{ type: 'QUICK_REPLY', text: b.text }];
      if (b.type === 'URL') return [{ type: 'URL', text: b.text, url: b.url ?? '', example: '' }];
      if (b.type === 'PHONE_NUMBER') return [{ type: 'PHONE_NUMBER', text: b.text, phoneNumber: b.phoneNumber ?? '' }];
      if (b.type === 'COPY_CODE') return [{ type: 'COPY_CODE', example: '' }];
      return [];
    }),
    securityRecommendation: true,
    codeExpirationMinutes: null,
  };
}

// What's sent to the server: only what applies to the category
export function cleanSpec(s: TemplateSpec) {
  if (s.category === 'AUTHENTICATION')
    return { name: s.name, category: s.category, language: s.language, securityRecommendation: s.securityRecommendation, codeExpirationMinutes: s.codeExpirationMinutes };
  return {
    name: s.name,
    category: s.category,
    language: s.language,
    header: s.header,
    body: s.body,
    bodyExamples: s.bodyExamples.slice(0, variablesOf(s.body).length),
    footer: s.footer.trim() || null,
    buttons: s.buttons,
  };
}

const withFile = async (path: string, method: 'POST' | 'PUT', spec: TemplateSpec, file: File) => {
  const q = new URLSearchParams({ spec: JSON.stringify(cleanSpec(spec)), fileName: file.name });
  const res = await fetch(`${API_URL}${path}?${q}`, { method, headers: { Authorization: `Bearer ${getToken() ?? ''}`, 'Content-Type': file.type || 'application/octet-stream' }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Couldn't save the template (${res.status})`);
  return data;
};
const needsFile = (s: TemplateSpec) => s.category !== 'AUTHENTICATION' && !!s.header && s.header.format !== 'TEXT';

export async function createTemplate(spec: TemplateSpec, file?: File | null): Promise<{ id: string; status: string; category: string }> {
  if (needsFile(spec)) {
    if (!file) throw new Error(`Add a sample ${spec.header!.format.toLowerCase()} for the header`);
    return withFile('/templates', 'POST', spec, file);
  }
  return (await gql<{ createMessageTemplate: { id: string; status: string; category: string } }>(`mutation CreateTemplate($s: String!) { createMessageTemplate(spec: $s) { id status category } }`, { s: JSON.stringify(cleanSpec(spec)) }))
    .createMessageTemplate;
}
export async function updateTemplate(id: string, spec: TemplateSpec, file?: File | null) {
  if (needsFile(spec)) {
    if (!file) throw new Error(`Add a sample ${spec.header!.format.toLowerCase()} for the header`);
    await withFile(`/templates/${encodeURIComponent(id)}`, 'PUT', spec, file);
    return;
  }
  await gql(`mutation UpdateTemplate($id: ID!, $s: String!) { updateMessageTemplate(id: $id, spec: $s) }`, { id, s: JSON.stringify(cleanSpec(spec)) });
}
export async function deleteTemplate(name: string, id?: string) {
  await gql(`mutation DeleteTemplate($n: String!, $id: ID) { deleteMessageTemplate(name: $n, id: $id) }`, { n: name, id: id ?? null });
}
