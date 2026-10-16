import { env } from './env.js';

type Account = { phoneNumberId: string; accessToken: string };

async function graphPost(account: Account, payload: object) {
  const res = await fetch(
    `https://graph.facebook.com/${env.graphVersion}/${account.phoneNumberId}/messages`,
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
export function sendText(account: Account, to: string, body: string) {
  return graphPost(account, { to, type: 'text', text: { body } });
}

// Uploads an image or document to WhatsApp and returns its media id (used to send it right after)
export async function uploadMedia(account: Account, bytes: Buffer, mime: string, fileName: string) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), fileName);
  const res = await fetch(`https://graph.facebook.com/${env.graphVersion}/${account.phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${account.accessToken}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.id) throw new Error(data?.error?.message ?? `Graph API error ${res.status}`);
  return data.id as string;
}

// Image with an optional caption: free-form, so only within 24h of the customer's last message (like text)
export function sendImage(account: Account, to: string, mediaId: string, caption?: string) {
  return graphPost(account, { to, type: 'image', image: { id: mediaId, ...(caption ? { caption } : {}) } });
}

// Document (PDF, Office, text) with its file name and an optional caption: free-form, so within 24 hours
export function sendDocument(account: Account, to: string, mediaId: string, filename: string, caption?: string) {
  return graphPost(account, { to, type: 'document', document: { id: mediaId, filename, ...(caption ? { caption } : {}) } });
}

// Downloads media a customer sent: WhatsApp gives a short-lived URL for the media id, then the file itself (both need
// the access token). Refuses anything over maxBytes. fetchImpl is replaceable for tests.
export async function downloadMedia(account: Account, mediaId: string, maxBytes: number, fetchImpl: typeof fetch = fetch) {
  const auth = { Authorization: `Bearer ${account.accessToken}` };
  const infoRes = await fetchImpl(`https://graph.facebook.com/${env.graphVersion}/${encodeURIComponent(mediaId)}`, { headers: auth });
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
export function sendAudio(account: Account, to: string, mediaId: string) {
  return graphPost(account, { to, type: 'audio', audio: { id: mediaId } });
}

// Approved template: allowed any time (this is what broadcasts use)
export function sendTemplate(account: Account, to: string, name: string, language = 'en') {
  return graphPost(account, { to, type: 'template', template: { name, language: { code: language } } });
}

export type ApprovedTemplate = { name: string; language: string; category: string; body: string; needsParameters: boolean };

// The account's APPROVED templates, one entry per name + language (each language is approved separately).
// needsParameters: it has {{variables}} or a media header, which sending without parameters would fail on.
export async function listApprovedTemplates(account: { wabaId: string; accessToken: string }): Promise<ApprovedTemplate[]> {
  const templates: ApprovedTemplate[] = [];
  let url: string | undefined =
    `https://graph.facebook.com/${env.graphVersion}/${account.wabaId}/message_templates` +
    '?fields=name,status,language,category,components&status=APPROVED&limit=100';
  for (let page = 0; url && page < 10; page++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${account.accessToken}` } });
    const data: any = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? `Graph API error ${res.status}`);
    for (const t of data.data ?? []) {
      if (t.status !== 'APPROVED') continue;
      const components: any[] = t.components ?? [];
      const needsParameters = components.some(
        (c) =>
          /\{\{.+?\}\}/.test(c.text ?? '') ||
          (c.type === 'HEADER' && c.format && c.format !== 'TEXT') ||
          (c.buttons ?? []).some((b: any) => /\{\{.+?\}\}/.test(b.url ?? '')),
      );
      const body = components.find((c) => c.type === 'BODY')?.text ?? '';
      templates.push({ name: t.name, language: t.language, category: t.category, body, needsParameters });
    }
    url = data.paging?.next;
  }
  return templates.sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
}
