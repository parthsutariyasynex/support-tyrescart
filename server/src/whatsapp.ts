import { env } from './env.js';
import { type TemplateInfo, parseTemplate } from './services/templateModel.js';

type Account = { phoneNumberId: string; accessToken: string };

async function graphPost(account: Account, payload: object) {
  const res = await fetch(
    `${env.graphBase}/${env.graphVersion}/${account.phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message ?? `Graph API error ${res.status}`);
  return data.messages[0].id as string; // wamid
}

// Free-form text: only allowed within 24h of the customer's last message
// replyTo: the wamid of the message this one replies to (WhatsApp shows it quoted above the text)
const context = (replyTo?: string | null) => (replyTo ? { context: { message_id: replyTo } } : {});

export function sendText(account: Account, to: string, body: string, replyTo?: string | null) {
  return graphPost(account, { to, type: 'text', text: { body }, ...context(replyTo) });
}

// A reaction to one of the chat's messages (its wamid); an empty emoji removes the business's reaction
export function sendReaction(account: Account, to: string, messageId: string, emoji: string) {
  return graphPost(account, { recipient_type: 'individual', to, type: 'reaction', reaction: { message_id: messageId, emoji } });
}

// Uploads an image or document to WhatsApp and returns its media id (used to send it right after)
export async function uploadMedia(account: Account, bytes: Buffer, mime: string, fileName: string) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), fileName);
  const res = await fetch(`${env.graphBase}/${env.graphVersion}/${account.phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${account.accessToken}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.id) throw new Error(data?.error?.message ?? `Graph API error ${res.status}`);
  return data.id as string;
}

// Image with an optional caption: free-form, so only within 24h of the customer's last message (like text)
export function sendImage(account: Account, to: string, mediaId: string, caption?: string, replyTo?: string | null) {
  return graphPost(account, { to, type: 'image', image: { id: mediaId, ...(caption ? { caption } : {}) }, ...context(replyTo) });
}

// Document (PDF, Office, text) with its file name and an optional caption: free-form, so within 24 hours
export function sendDocument(account: Account, to: string, mediaId: string, filename: string, caption?: string, replyTo?: string | null) {
  return graphPost(account, { to, type: 'document', document: { id: mediaId, filename, ...(caption ? { caption } : {}) }, ...context(replyTo) });
}

// Downloads media a customer sent: WhatsApp gives a short-lived URL for the media id, then the file itself (both need
// the access token). Refuses anything over maxBytes. fetchImpl is replaceable for tests.
export async function downloadMedia(account: Account, mediaId: string, maxBytes: number, fetchImpl: typeof fetch = fetch) {
  const auth = { Authorization: `Bearer ${account.accessToken}` };
  const infoRes = await fetchImpl(`${env.graphBase}/${env.graphVersion}/${encodeURIComponent(mediaId)}`, { headers: auth });
  const info = await infoRes.json().catch(() => ({}));
  if (!infoRes.ok || typeof info?.url !== 'string') throw new Error(info?.error?.message ?? `Graph API error ${infoRes.status}`);
  if (Number(info.file_size) > maxBytes) throw new Error('The file is too large to download');
  const fileRes = await fetchImpl(info.url, { headers: auth });
  if (!fileRes.ok) throw new Error(`Media download failed (${fileRes.status})`);
  const bytes = Buffer.from(await fileRes.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error('The file is too large to download');
  return { bytes, mime: String(info.mime_type ?? fileRes.headers.get('content-type') ?? '') };
}

// Audio: an OGG/Opus file shows on the customer's phone as a voice note; free-form, so within 24 hours
export function sendAudio(account: Account, to: string, mediaId: string, replyTo?: string | null) {
  return graphPost(account, { to, type: 'audio', audio: { id: mediaId }, ...context(replyTo) });
}

// Approved template: allowed any time (this is what broadcasts use)
export function sendTemplate(account: Account, to: string, name: string, language = 'en') {
  return graphPost(account, { to, type: 'template', template: { name, language: { code: language } } });
}

// needsParameters: it has {{variables}}, a media header or a coupon/code button, so it can't go out without values
export type ApprovedTemplate = TemplateInfo & { needsParameters: boolean };
type Waba = { wabaId: string; accessToken: string };

async function graphJson(url: string, token: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...((init.headers as Record<string, string>) ?? {}) },
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.error_user_msg || data?.error?.message || `Graph API error ${res.status}`);
  return data;
}

// Every template of the account (each name + language is its own template), any status unless approvedOnly
export async function listTemplates(account: Waba, approvedOnly = false): Promise<TemplateInfo[]> {
  const out: TemplateInfo[] = [];
  let url: string | undefined =
    `${env.graphBase}/${env.graphVersion}/${account.wabaId}/message_templates` +
    `?fields=id,name,status,language,category,components,rejected_reason,parameter_format&limit=100${approvedOnly ? '&status=APPROVED' : ''}`;
  for (let page = 0; url && page < 20; page++) {
    const data = await graphJson(url, account.accessToken);
    for (const t of data.data ?? []) if (!approvedOnly || t.status === 'APPROVED') out.push(parseTemplate(t));
    url = data.paging?.next;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
}

// Meta's sample template, added to every WhatsApp Business account by Meta itself (not one of ours)
export const META_SAMPLE_TEMPLATES: readonly string[] = ['hello_world'];

// The account's APPROVED templates that agents may send, one entry per name + language (each language is approved
// separately). Pending, rejected, paused and disabled ones never come back (Meta is asked for APPROVED, and the
// status is checked again), and neither does Meta's sample. Sending checks against this same list.
export async function listApprovedTemplates(account: Waba): Promise<ApprovedTemplate[]> {
  return (await listTemplates(account, true)).filter((t) => t.status === 'APPROVED' && !META_SAMPLE_TEMPLATES.includes(t.name)).map((t) => ({
    ...t,
    needsParameters:
      !!t.header?.variables.length ||
      ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(t.header?.format ?? '') ||
      t.body.variables.length > 0 ||
      t.buttons.some((b) => b.variables.length > 0 || b.type === 'COPY_CODE' || b.type === 'OTP'),
  }));
}

// A template with its values (components built by templateModel.buildSendComponents)
export function sendTemplateWithValues(account: Account, to: string, name: string, language: string, components: object[]) {
  return graphPost(account, { to, type: 'template', template: { name, language: { code: language }, ...(components.length ? { components } : {}) } });
}

// Settings → Templates: submit a new template for Meta's review; returns its id and status (usually PENDING)
export async function createTemplate(account: Waba, payload: { name: string; language: string; category: string; components: object[] }) {
  const data = await graphJson(`${env.graphBase}/${env.graphVersion}/${account.wabaId}/message_templates`, account.accessToken, {
    method: 'POST',
    body: JSON.stringify({ ...payload, allow_category_change: true }),
  });
  return { id: String(data.id ?? ''), status: String(data.status ?? 'PENDING'), category: String(data.category ?? payload.category) };
}

// Edit an existing template (Meta reviews it again)
export async function editTemplate(account: Waba, templateId: string, payload: { category?: string; components: object[] }) {
  await graphJson(`${env.graphBase}/${env.graphVersion}/${encodeURIComponent(templateId)}`, account.accessToken, { method: 'POST', body: JSON.stringify(payload) });
}

// Delete a template: with its id only that language; without, every language of the name
export async function deleteTemplate(account: Waba, name: string, templateId?: string) {
  const q = new URLSearchParams({ name, ...(templateId ? { hsm_id: templateId } : {}) });
  await graphJson(`${env.graphBase}/${env.graphVersion}/${account.wabaId}/message_templates?${q}`, account.accessToken, { method: 'DELETE' });
}

// A sample file for a media header (Resumable Upload API of the Meta app): returns the handle Meta wants
export async function uploadTemplateSample(appId: string, token: string, bytes: Buffer, mime: string, fileName: string) {
  const q = new URLSearchParams({ file_name: fileName, file_length: String(bytes.length), file_type: mime });
  const session = await graphJson(`${env.graphBase}/${env.graphVersion}/${encodeURIComponent(appId)}/uploads?${q}`, token, { method: 'POST' });
  const res = await fetch(`${env.graphBase}/${env.graphVersion}/${session.id}`, {
    method: 'POST',
    headers: { Authorization: `OAuth ${token}`, file_offset: '0', 'Content-Type': mime },
    body: new Uint8Array(bytes),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || typeof data?.h !== 'string') throw new Error(data?.error?.message ?? `Couldn't upload the sample file (${res.status})`);
  return data.h as string;
}
