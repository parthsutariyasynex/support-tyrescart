import { z } from 'zod';
import { AppError } from './errors.js';

// WhatsApp message templates: reading Meta's template format, the variables ({{1}} or {{name}}) to fill in, the
// payload that sends a template with its values, the text the chat shows for it, and the payload that creates or
// edits one. No I/O here (see whatsapp.ts and services/templates.ts).

export type HeaderFormat = 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION';
export type TemplateButton = { type: string; text: string; url?: string; phoneNumber?: string; variables: string[] };
export type TemplateInfo = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  rejectedReason: string | null;
  parameterFormat: 'POSITIONAL' | 'NAMED';
  header: { format: HeaderFormat; text: string; variables: string[] } | null;
  body: { text: string; variables: string[] };
  footer: string | null;
  buttons: TemplateButton[];
  // Whether this app can send it (carousels, catalogs and flows can't be sent from here yet)
  sendable: boolean;
  unsupportedReason: string | null;
};

const VAR_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
// The variables of a text in order of first appearance: ["1","2"] or ["customer_name", …]
export function variablesOf(text: string | null | undefined) {
  const out: string[] = [];
  for (const m of (text ?? '').matchAll(VAR_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

// Meta's template (from /message_templates) as this app uses it
export function parseTemplate(t: any): TemplateInfo {
  const components: any[] = Array.isArray(t?.components) ? t.components : [];
  const find = (type: string) => components.find((c) => c?.type === type);
  const h = find('HEADER');
  const b = find('BODY');
  const f = find('FOOTER');
  const btns: any[] = find('BUTTONS')?.buttons ?? [];
  const unsupported = components.find((c) => ['CAROUSEL', 'LIMITED_TIME_OFFER'].includes(c?.type)) ?? btns.find((x) => ['FLOW', 'CATALOG', 'MPM', 'SPM'].includes(x?.type));
  const headerFormat = typeof h?.format === 'string' ? (h.format as HeaderFormat) : null;
  return {
    id: String(t?.id ?? ''),
    name: String(t?.name ?? ''),
    language: String(t?.language ?? ''),
    category: String(t?.category ?? ''),
    status: String(t?.status ?? ''),
    rejectedReason: typeof t?.rejected_reason === 'string' && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
    parameterFormat: t?.parameter_format === 'NAMED' ? 'NAMED' : 'POSITIONAL',
    header: h && headerFormat ? { format: headerFormat, text: typeof h.text === 'string' ? h.text : '', variables: headerFormat === 'TEXT' ? variablesOf(h.text) : [] } : null,
    body: { text: typeof b?.text === 'string' ? b.text : '', variables: variablesOf(b?.text) },
    footer: typeof f?.text === 'string' ? f.text : null,
    buttons: btns.map((x) => ({
      type: String(x?.type ?? ''),
      text: String(x?.text ?? ''),
      ...(typeof x?.url === 'string' ? { url: x.url } : {}),
      ...(typeof x?.phone_number === 'string' ? { phoneNumber: x.phone_number } : {}),
      variables: x?.type === 'URL' ? variablesOf(x.url) : [],
    })),
    sendable: !unsupported && headerFormat !== 'LOCATION',
    unsupportedReason: unsupported
      ? `${String(unsupported.type ?? 'This kind of').toLowerCase().replace(/_/g, ' ')} templates can't be sent from here yet`
      : headerFormat === 'LOCATION'
        ? "Templates with a location header can't be sent from here yet"
        : null,
  };
}

// --- Sending

// What the sender fills in: values per variable, a coupon code for a copy-code button, the header file (sent
// separately: media id)
export const sendValuesSchema = z.object({
  header: z.record(z.string(), z.string().trim().max(60, 'Header values can be up to 60 characters')).default({}),
  body: z.record(z.string(), z.string().trim().max(1024, 'Values can be up to 1024 characters')).default({}),
  // per button index (URL buttons: the variable part of the link; copy code: the coupon)
  buttons: z.record(z.string(), z.string().trim().max(2000)).default({}),
});
export type SendValues = z.infer<typeof sendValuesSchema>;

const missing = (what: string) => new AppError(`Fill in ${what}`, 400, 'BAD_USER_INPUT');

// The "components" that send this template with these values (Cloud API format)
export function buildSendComponents(t: TemplateInfo, values: SendValues, media?: { id: string; filename?: string }) {
  const named = t.parameterFormat === 'NAMED';
  const param = (name: string, text: string) => ({ type: 'text', text, ...(named ? { parameter_name: name } : {}) });
  const components: object[] = [];
  if (t.header) {
    if (t.header.format === 'TEXT' && t.header.variables.length) {
      components.push({
        type: 'header',
        parameters: t.header.variables.map((v) => {
          const value = values.header[v]?.trim();
          if (!value) throw missing(`the header value {{${v}}}`);
          return param(v, value);
        }),
      });
    } else if (t.header.format === 'IMAGE' || t.header.format === 'VIDEO' || t.header.format === 'DOCUMENT') {
      if (!media?.id) throw missing(`the header ${t.header.format.toLowerCase()}`);
      const kind = t.header.format.toLowerCase();
      components.push({ type: 'header', parameters: [{ type: kind, [kind]: { id: media.id, ...(kind === 'document' && media.filename ? { filename: media.filename } : {}) } }] });
    }
  }
  if (t.body.variables.length) {
    components.push({
      type: 'body',
      parameters: t.body.variables.map((v) => {
        const value = values.body[v]?.trim();
        if (!value) throw missing(`{{${v}}}`);
        return param(v, value);
      }),
    });
  }
  t.buttons.forEach((b, index) => {
    if (b.type === 'URL' && b.variables.length) {
      const value = values.buttons[String(index)]?.trim();
      if (!value) throw missing(`the link for “${b.text}”`);
      components.push({ type: 'button', sub_type: 'url', index: String(index), parameters: [{ type: 'text', text: value }] });
    } else if (b.type === 'COPY_CODE') {
      const value = values.buttons[String(index)]?.trim();
      if (!value) throw missing('the coupon code');
      components.push({ type: 'button', sub_type: 'copy_code', index: String(index), parameters: [{ type: 'coupon_code', coupon_code: value }] });
    } else if (b.type === 'OTP') {
      // Authentication: the code goes in the body ({{1}}) and in the copy-code button
      const code = values.body[t.body.variables[0] ?? '1']?.trim();
      if (!code) throw missing('the code');
      components.push({ type: 'button', sub_type: 'url', index: String(index), parameters: [{ type: 'text', text: code }] });
    }
  });
  return components;
}

const fill = (text: string, values: Record<string, string>) => text.replace(VAR_RE, (_, v: string) => values[v]?.trim() || `{{${v}}}`);

// What the chat shows for a sent template: header text, body and footer with the values filled in, then the buttons
export function renderTemplate(t: TemplateInfo, values: SendValues) {
  const parts = [
    t.header?.format === 'TEXT' && t.header.text ? fill(t.header.text, values.header) : '',
    fill(t.body.text, values.body),
    t.footer ?? '',
    t.buttons.length ? t.buttons.map((b) => `[${b.text}]`).join(' ') : '',
  ].filter(Boolean);
  // A name the customer doesn't have is sent as an invisible character (WhatsApp refuses empty values); the chat
  // shows the text without it: "Hello \u200B 👋," → "Hello 👋,"
  return parts.join('\n\n').replace(/ *\u200B *([,.!?;:])/g, '$1').replace(/ *\u200B */g, ' ');
}

// --- Creating and editing (Settings → Templates)

export const CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'] as const;
// Languages offered when creating a template (Meta's codes); any code Meta supports is accepted
export const TEMPLATE_LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'en_US', label: 'English (US)' },
  { value: 'en_GB', label: 'English (UK)' },
  { value: 'ar', label: 'Arabic' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ur', label: 'Urdu' },
  { value: 'fr', label: 'French' },
  { value: 'es', label: 'Spanish' },
  { value: 'de', label: 'German' },
  { value: 'ru', label: 'Russian' },
  { value: 'tr', label: 'Turkish' },
  { value: 'fa', label: 'Persian' },
  { value: 'pt_BR', label: 'Portuguese (BR)' },
  { value: 'zh_CN', label: 'Chinese (CHN)' },
  { value: 'ml', label: 'Malayalam' },
  { value: 'ta', label: 'Tamil' },
  { value: 'bn', label: 'Bengali' },
] as const;

const buttonSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('QUICK_REPLY'), text: z.string().trim().min(1, 'Button text is required').max(25, 'Button text: up to 25 characters') }),
  z.object({
    type: z.literal('URL'),
    text: z.string().trim().min(1, 'Button text is required').max(25, 'Button text: up to 25 characters'),
    url: z.string().trim().url('Enter a full link, e.g. https://tyrescart.ae/orders/{{1}}').max(2000),
    example: z.string().trim().max(2000).optional(),
  }),
  z.object({
    type: z.literal('PHONE_NUMBER'),
    text: z.string().trim().min(1, 'Button text is required').max(25, 'Button text: up to 25 characters'),
    phoneNumber: z.string().trim().regex(/^\+?[0-9]{6,20}$/, 'Enter the phone number with its country code, e.g. +97145550101'),
  }),
  z.object({ type: z.literal('COPY_CODE'), example: z.string().trim().min(1, 'Add a sample coupon code').max(15, 'Coupon codes: up to 15 characters') }),
]);

export const templateSpecSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Enter a template name')
      .max(512)
      .regex(/^[a-z0-9_]+$/, 'Names use lowercase letters, numbers and underscores only, e.g. order_ready'),
    category: z.enum(CATEGORIES, { message: 'Choose a category' }),
    language: z.string().trim().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, 'Choose a language'),
    header: z
      .object({
        format: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']),
        text: z.string().trim().max(60, 'Header text: up to 60 characters').optional(),
        example: z.string().trim().max(60).optional(),
      })
      .nullable()
      .optional(),
    body: z.string().trim().max(1024, 'Body: up to 1024 characters').default(''),
    // a sample value per body variable, in order (Meta reviews with them)
    bodyExamples: z.array(z.string().trim().max(200)).max(50).default([]),
    footer: z.string().trim().max(60, 'Footer: up to 60 characters').nullable().optional(),
    buttons: z.array(buttonSchema).max(10, 'Up to 10 buttons').default([]),
    // Authentication templates: Meta writes the text; these are its options
    securityRecommendation: z.boolean().default(true),
    codeExpirationMinutes: z.number().int().min(1).max(90).nullable().optional(),
  })
  .superRefine((s, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (s.category === 'AUTHENTICATION') return;
    if (!s.body) issue('Write the message body');
    const vars = variablesOf(s.body);
    if (vars.some((v) => !/^\d+$/.test(v))) issue('Use numbered variables: {{1}}, {{2}}, …');
    vars.forEach((v, i) => v !== String(i + 1) && issue(`Number the variables in order: {{${i + 1}}} comes before {{${v}}}`));
    if (vars.length && s.bodyExamples.filter((e) => e).length < vars.length) issue('Add a sample value for each variable');
    if (/^\s*\{\{/.test(s.body) || /\}\}\s*$/.test(s.body)) issue("The body can't start or end with a variable");
    if (s.header?.format === 'TEXT') {
      if (!s.header.text) issue('Write the header text');
      const hv = variablesOf(s.header.text);
      if (hv.length > 1) issue('The header can have one variable at most');
      if (hv.length && !s.header.example) issue('Add a sample value for the header variable');
    }
    const count = (type: string) => s.buttons.filter((b) => b.type === type).length;
    if (count('URL') > 2) issue('Up to 2 website buttons');
    if (count('PHONE_NUMBER') > 1) issue('Up to 1 phone button');
    if (count('COPY_CODE') > 1) issue('Up to 1 copy-code button');
    for (const b of s.buttons) if (b.type === 'URL' && variablesOf(b.url).length && !b.example) issue(`Add a sample link for “${b.text}”`);
  });
export type TemplateSpec = z.infer<typeof templateSpecSchema>;

// The components Meta wants for a new or edited template; `headerHandle` = the sample file for a media header
export function buildCreateComponents(spec: TemplateSpec, headerHandle?: string) {
  if (spec.category === 'AUTHENTICATION') {
    return [
      { type: 'BODY', add_security_recommendation: spec.securityRecommendation },
      ...(spec.codeExpirationMinutes ? [{ type: 'FOOTER', code_expiration_minutes: spec.codeExpirationMinutes }] : []),
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }] },
    ];
  }
  const components: object[] = [];
  if (spec.header?.format === 'TEXT') {
    components.push({ type: 'HEADER', format: 'TEXT', text: spec.header.text, ...(variablesOf(spec.header.text).length ? { example: { header_text: [spec.header.example] } } : {}) });
  } else if (spec.header) {
    if (!headerHandle) throw new AppError(`Add a sample ${spec.header.format.toLowerCase()} for the header`, 400, 'BAD_USER_INPUT');
    components.push({ type: 'HEADER', format: spec.header.format, example: { header_handle: [headerHandle] } });
  }
  const vars = variablesOf(spec.body);
  components.push({ type: 'BODY', text: spec.body, ...(vars.length ? { example: { body_text: [spec.bodyExamples.slice(0, vars.length)] } } : {}) });
  if (spec.footer) components.push({ type: 'FOOTER', text: spec.footer });
  if (spec.buttons.length) {
    components.push({
      type: 'BUTTONS',
      buttons: spec.buttons.map((b) => {
        if (b.type === 'QUICK_REPLY') return { type: 'QUICK_REPLY', text: b.text };
        if (b.type === 'PHONE_NUMBER') return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phoneNumber };
        if (b.type === 'COPY_CODE') return { type: 'COPY_CODE', example: b.example };
        return { type: 'URL', text: b.text, url: b.url, ...(variablesOf(b.url).length ? { example: [b.example] } : {}) };
      }),
    });
  }
  return components;
}
