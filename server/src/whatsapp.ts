import { env } from './env.js';
import { describeMetaFailure, errorDetailsOf, logEvent } from './services/logging.js';
import { type TemplateInfo, parseTemplate } from './services/templateModel.js';

type Account = { phoneNumberId: string; accessToken: string };

// A refusal from Meta's Graph API. The message is exactly what callers showed before; Meta's numeric error code
// (e.g. 131047 window closed, 131049 not delivered for healthy ecosystem engagement), its subcode and trace id are
// kept for the logs.
export class GraphApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: number | null = null,
    public subcode: number | null = null,
    public fbtraceId: string | null = null,
    // Meta's explanation (error_data.details), when it gave one
    public details: string | null = null,
    // Meta's whole answer, for the logs
    public body: unknown = null,
  ) {
    super(message);
    this.name = 'GraphApiError';
  }
}

const numberOrNull = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// No answer from Meta in time (META_TIMEOUT_MS, or META_UPLOAD_TIMEOUT_MS for files): the request was given up, so
// whether Meta acted on it is unknown
export class MetaTimeoutError extends Error {
  constructor(public timeoutMs: number) {
    super(`No answer from Meta within ${Math.round(timeoutMs / 1000)} s; the request was given up`);
    this.name = 'MetaTimeoutError';
  }
}

// An answer from Meta that can't be read as what was asked (not JSON, e.g. an error page, or a send answered
// without a message id): what Meta did is unknown
export class MetaResponseError extends Error {
  constructor(message: string, public status: number, public contentType: string | null = null, public bytes: number | null = null) {
    super(message);
    this.name = 'MetaResponseError';
  }
}

// fetch with a time limit: a call that hangs ends as a MetaTimeoutError instead of waiting forever
async function metaFetch(url: string, init: RequestInit, timeoutMs: number, fetchImpl: typeof fetch = fetch) {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if ((err as Error)?.name === 'TimeoutError') throw new MetaTimeoutError(timeoutMs);
    throw err;
  }
}

// Meta's answer as JSON; an answer that isn't JSON is reported as such (with its status and type, never its body)
async function readJson(res: Response, timeoutMs: number): Promise<any> {
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    if ((err as Error)?.name === 'TimeoutError') throw new MetaTimeoutError(timeoutMs);
    throw err;
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    const type = res.headers.get('content-type');
    throw new MetaResponseError(`Meta answered HTTP ${res.status} with a response that isn't JSON (${type ?? 'no content type'}, ${Buffer.byteLength(text)} bytes)`, res.status, type, Buffer.byteLength(text));
  }
}

export function graphError(status: number, data: any, message: string) {
  const e = data?.error ?? {};
  const details = typeof e.error_data?.details === 'string' ? e.error_data.details : typeof e.error_data === 'string' ? e.error_data : null;
  return new GraphApiError(message, status, numberOrNull(e.code), numberOrNull(e.error_subcode), typeof e.fbtrace_id === 'string' ? e.fbtrace_id : null, details, data ?? null);
}

// What was asked and what Meta answered, filled in by the call: the request's payload (never the access token or a
// file's bytes), its HTTP status, Meta's whole answer, and on a send Meta's message_status (e.g. "accepted", or
// "held_for_quality_assessment" when Meta holds the message back for now)
type MetaAnswer = { request?: unknown; httpStatus?: number; body?: unknown; messageStatus?: string | null };

// A template's values hidden (an authentication template's values are a one-time code)
function hideTemplateValues(payload: any) {
  const components = payload?.template?.components;
  if (!Array.isArray(components)) return payload;
  const hide = (p: any) => (p && typeof p === 'object' ? { ...p, ...(typeof p.text === 'string' ? { text: '[REDACTED]' } : {}), ...(p.coupon_code ? { coupon_code: '[REDACTED]' } : {}) } : p);
  return { ...payload, template: { ...payload.template, components: components.map((c: any) => ({ ...c, ...(Array.isArray(c?.parameters) ? { parameters: c.parameters.map(hide) } : {}) })) } };
}

// Every Graph API call is logged (direction out): which call, how long it took, Meta's answer (its HTTP status, and
// on a send the message's waRef and Meta's message_status; Meta's whole body only when the call failed) or, when it
// failed, why (describeMetaFailure: Meta's status, code, subcode, trace id, details and whole error body, a timeout,
// or a network error). Inside withMessageTrace the entry
// names the message being sent. Never the access token, the customer's number or the message text.
async function logged<T>(call: string, details: Record<string, unknown>, fn: (answer: MetaAnswer) => Promise<T>): Promise<T> {
  const started = Date.now();
  const answer: MetaAnswer = {};
  const send = call === 'send';
  const what = details.type ? `Deliver a ${details.type} message to the customer through Meta` : `Meta's ${call.replace(/_/g, ' ')} was needed`;
  try {
    const result = await fn(answer);
    const waMessageId = send && typeof result === 'string' ? result : null;
    const mediaId = call === 'upload_media' && typeof result === 'string' ? result : null;
    const held = send && !!answer.messageStatus && answer.messageStatus !== 'accepted';
    void logEvent({
      level: held ? 'WARNING' : 'SUCCESS',
      category: 'whatsapp',
      event: `whatsapp.${call}`,
      message: send
        ? `Meta accepted the message (HTTP ${answer.httpStatus ?? 200}${answer.messageStatus ? `, message_status "${answer.messageStatus}"` : ''})${held ? ': Meta is holding it back for now, so it may be delivered later or not at all' : ''}`
        : `Meta API ${call} succeeded`,
      direction: 'out',
      outcome: 'accepted',
      reason: what,
      waMessageId,
      ...(send ? { messageSent: 1 as const, customerReceived: null, deliveryStatus: 'sent' } : {}),
      durationMs: Date.now() - started,
      ...(answer.request !== undefined ? { request: answer.request } : {}),
      response: {
        ok: true,
        httpStatus: answer.httpStatus ?? null,
        ...(waMessageId ? { waMessageId } : {}),
        ...(answer.messageStatus ? { messageStatus: answer.messageStatus } : {}),
        ...(mediaId ? { mediaId } : {}),
      },
      data: details,
    });
    return result;
  } catch (err) {
    const f = describeMetaFailure(err);
    void logEvent({
      level: 'ERROR',
      category: 'whatsapp',
      event: `whatsapp.${call}`,
      message: `Meta API ${call} failed: ${f.reason}`,
      direction: 'out',
      outcome: f.outcome,
      reason: what,
      ...(send ? { messageSent: f.sent, customerReceived: f.sent, deliveryStatus: f.sent === 0 ? 'failed' : null } : {}),
      errorCode: f.errorCode,
      errorDetails: errorDetailsOf(err),
      durationMs: Date.now() - started,
      ...(answer.request !== undefined ? { request: answer.request } : {}),
      response: f.response,
      data: details,
    });
    throw err;
  }
}

// secret: the payload's template values are a one-time code (an authentication template): hidden in the logs
function graphPost(account: Account, payload: { type: string; [key: string]: unknown }, { secret = false } = {}) {
  return logged('send', { type: payload.type }, (answer) => graphPostOnce(account, payload, answer, secret));
}

async function graphPostOnce(account: Account, payload: object, answer: MetaAnswer, secret = false) {
  const body = { messaging_product: 'whatsapp', ...payload };
  answer.request = secret ? hideTemplateValues(body) : body;
  const res = await metaFetch(
    `${env.graphBase}/${env.graphVersion}/${account.phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    env.metaTimeoutMs,
  );
  const data = await readJson(res, env.metaTimeoutMs);
  answer.httpStatus = res.status;
  answer.body = data;
  if (!res.ok) throw graphError(res.status, data, data?.error?.message ?? `Graph API error ${res.status}`);
  const sent = data?.messages?.[0];
  if (typeof sent?.id !== 'string' || !sent.id) throw new MetaResponseError(`Meta answered HTTP ${res.status} without a message id`, res.status, res.headers.get('content-type'));
  answer.messageStatus = typeof sent.message_status === 'string' ? sent.message_status : null;
  return sent.id as string; // wamid
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

// Uploads an image, video or document to WhatsApp and returns its media id (used to send it right after)
export function uploadMedia(account: Account, bytes: Buffer, mime: string, fileName: string) {
  return logged('upload_media', { mime, bytes: bytes.length }, (answer) => uploadMediaOnce(account, bytes, mime, fileName, answer));
}

async function uploadMediaOnce(account: Account, bytes: Buffer, mime: string, fileName: string, answer: MetaAnswer) {
  answer.request = { type: mime, fileName, bytes: bytes.length }; // what was uploaded, never the file itself
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), fileName);
  const res = await metaFetch(
    `${env.graphBase}/${env.graphVersion}/${account.phoneNumberId}/media`,
    { method: 'POST', headers: { Authorization: `Bearer ${account.accessToken}` }, body: form },
    env.metaUploadTimeoutMs,
  );
  const data = await readJson(res, env.metaUploadTimeoutMs);
  answer.httpStatus = res.status;
  answer.body = data;
  if (!res.ok) throw graphError(res.status, data, data?.error?.message ?? `Graph API error ${res.status}`);
  if (!data?.id) throw new MetaResponseError(`Meta answered HTTP ${res.status} without a media id`, res.status, res.headers.get('content-type'));
  return data.id as string;
}

// Image with an optional caption: free-form, so only within 24h of the customer's last message (like text)
export function sendImage(account: Account, to: string, mediaId: string, caption?: string, replyTo?: string | null) {
  return graphPost(account, { to, type: 'image', image: { id: mediaId, ...(caption ? { caption } : {}) }, ...context(replyTo) });
}

// Video (MP4 or 3GP, up to 16 MB) with an optional caption: free-form, so within 24 hours (like images)
export function sendVideo(account: Account, to: string, mediaId: string, caption?: string, replyTo?: string | null) {
  return graphPost(account, { to, type: 'video', video: { id: mediaId, ...(caption ? { caption } : {}) }, ...context(replyTo) });
}

// Document (PDF, Office, text) with its file name and an optional caption: free-form, so within 24 hours
export function sendDocument(account: Account, to: string, mediaId: string, filename: string, caption?: string, replyTo?: string | null) {
  return graphPost(account, { to, type: 'document', document: { id: mediaId, filename, ...(caption ? { caption } : {}) }, ...context(replyTo) });
}

// Downloads media a customer sent: WhatsApp gives a short-lived URL for the media id, then the file itself (both need
// the access token). Refuses anything over maxBytes. fetchImpl is replaceable for tests.
export function downloadMedia(account: Account, mediaId: string, maxBytes: number, fetchImpl: typeof fetch = fetch) {
  return logged('download_media', { mediaId }, () => downloadMediaOnce(account, mediaId, maxBytes, fetchImpl));
}

async function downloadMediaOnce(account: Account, mediaId: string, maxBytes: number, fetchImpl: typeof fetch) {
  const auth = { Authorization: `Bearer ${account.accessToken}` };
  const infoRes = await metaFetch(`${env.graphBase}/${env.graphVersion}/${encodeURIComponent(mediaId)}`, { headers: auth }, env.metaTimeoutMs, fetchImpl);
  const info = await readJson(infoRes, env.metaTimeoutMs).catch(() => ({}));
  if (!infoRes.ok || typeof info?.url !== 'string') throw graphError(infoRes.status, info, info?.error?.message ?? `Graph API error ${infoRes.status}`);
  if (Number(info.file_size) > maxBytes) throw new Error('The file is too large to download');
  const fileRes = await metaFetch(info.url, { headers: auth }, env.metaUploadTimeoutMs, fetchImpl);
  if (!fileRes.ok) throw new Error(`Media download failed (${fileRes.status})`);
  const bytes = await fileRes.arrayBuffer().then(
    (b) => Buffer.from(b),
    (err) => {
      throw (err as Error)?.name === 'TimeoutError' ? new MetaTimeoutError(env.metaUploadTimeoutMs) : err;
    },
  );
  if (bytes.length > maxBytes) throw new Error('The file is too large to download');
  return { bytes, mime: String(info.mime_type ?? fileRes.headers.get('content-type') ?? '') };
}

// Audio: an OGG/Opus file shows on the customer's phone as a voice note; free-form, so within 24 hours
export function sendAudio(account: Account, to: string, mediaId: string, replyTo?: string | null) {
  return graphPost(account, { to, type: 'audio', audio: { id: mediaId }, ...context(replyTo) });
}

// A location pin (Meta's "location" type): coordinates, with the place's name and address when known; free-form,
// so within 24 hours like text
export function sendLocation(
  account: Account,
  to: string,
  place: { latitude: number; longitude: number; name?: string | null; address?: string | null },
  replyTo?: string | null,
) {
  const location = { latitude: place.latitude, longitude: place.longitude, ...(place.name ? { name: place.name } : {}), ...(place.address ? { address: place.address } : {}) };
  return graphPost(account, { to, type: 'location', location, ...context(replyTo) });
}

// Approved template: allowed any time (this is what broadcasts use)
export function sendTemplate(account: Account, to: string, name: string, language = 'en') {
  return graphPost(account, { to, type: 'template', template: { name, language: { code: language } } });
}

// needsParameters: it has {{variables}}, a media header or a coupon/code button, so it can't go out without values
export type ApprovedTemplate = TemplateInfo & { needsParameters: boolean };
type Waba = { wabaId: string; accessToken: string };

async function graphJson(url: string, token: string, init: RequestInit = {}) {
  const res = await metaFetch(
    url,
    { ...init, headers: { Authorization: `Bearer ${token}`, ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...((init.headers as Record<string, string>) ?? {}) } },
    env.metaTimeoutMs,
  );
  const data: any = await readJson(res, env.metaTimeoutMs).catch((err) => {
    if (err instanceof MetaTimeoutError || res.ok) throw err;
    return {}; // an error answer that isn't JSON: graphError below reports its status
  });
  if (!res.ok) throw graphError(res.status, data, data?.error?.error_user_msg || data?.error?.message || `Graph API error ${res.status}`);
  return data;
}

// Every template of the account (each name + language is its own template), any status unless approvedOnly
export function listTemplates(account: Waba, approvedOnly = false): Promise<TemplateInfo[]> {
  return logged('list_templates', { approvedOnly }, () => listTemplatesOnce(account, approvedOnly));
}

async function listTemplatesOnce(account: Waba, approvedOnly: boolean): Promise<TemplateInfo[]> {
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
// secret: an authentication template (its values are a one-time code, never logged)
export function sendTemplateWithValues(account: Account, to: string, name: string, language: string, components: object[], { secret = false } = {}) {
  return graphPost(account, { to, type: 'template', template: { name, language: { code: language }, ...(components.length ? { components } : {}) } }, { secret });
}

// Settings → Templates: submit a new template for Meta's review; returns its id and status (usually PENDING)
export async function createTemplate(account: Waba, payload: { name: string; language: string; category: string; components: object[] }) {
  const data = await logged('create_template', { name: payload.name, language: payload.language, category: payload.category }, () => graphJson(`${env.graphBase}/${env.graphVersion}/${account.wabaId}/message_templates`, account.accessToken, {
    method: 'POST',
    body: JSON.stringify({ ...payload, allow_category_change: true }),
  }));
  return { id: String(data.id ?? ''), status: String(data.status ?? 'PENDING'), category: String(data.category ?? payload.category) };
}

// Edit an existing template (Meta reviews it again)
export async function editTemplate(account: Waba, templateId: string, payload: { category?: string; components: object[] }) {
  await logged('edit_template', { templateId }, () =>
    graphJson(`${env.graphBase}/${env.graphVersion}/${encodeURIComponent(templateId)}`, account.accessToken, { method: 'POST', body: JSON.stringify(payload) }),
  );
}

// Delete a template: with its id only that language; without, every language of the name
export async function deleteTemplate(account: Waba, name: string, templateId?: string) {
  const q = new URLSearchParams({ name, ...(templateId ? { hsm_id: templateId } : {}) });
  await logged('delete_template', { name, templateId: templateId ?? null }, () =>
    graphJson(`${env.graphBase}/${env.graphVersion}/${account.wabaId}/message_templates?${q}`, account.accessToken, { method: 'DELETE' }),
  );
}

// A sample file for a media header (Resumable Upload API of the Meta app): returns the handle Meta wants
export function uploadTemplateSample(appId: string, token: string, bytes: Buffer, mime: string, fileName: string) {
  return logged('upload_template_sample', { mime, bytes: bytes.length }, () => uploadTemplateSampleOnce(appId, token, bytes, mime, fileName));
}

async function uploadTemplateSampleOnce(appId: string, token: string, bytes: Buffer, mime: string, fileName: string) {
  const q = new URLSearchParams({ file_name: fileName, file_length: String(bytes.length), file_type: mime });
  const session = await graphJson(`${env.graphBase}/${env.graphVersion}/${encodeURIComponent(appId)}/uploads?${q}`, token, { method: 'POST' });
  const res = await metaFetch(
    `${env.graphBase}/${env.graphVersion}/${session.id}`,
    { method: 'POST', headers: { Authorization: `OAuth ${token}`, file_offset: '0', 'Content-Type': mime }, body: new Uint8Array(bytes) },
    env.metaUploadTimeoutMs,
  );
  const data: any = await readJson(res, env.metaUploadTimeoutMs).catch((err) => {
    if (err instanceof MetaTimeoutError) throw err;
    return {};
  });
  if (!res.ok || typeof data?.h !== 'string') throw graphError(res.status, data, data?.error?.message ?? `Couldn't upload the sample file (${res.status})`);
  return data.h as string;
}
