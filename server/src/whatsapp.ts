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
