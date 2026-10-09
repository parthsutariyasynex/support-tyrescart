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
