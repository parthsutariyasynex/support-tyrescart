import { gql } from './api';

export type WhatsAppAccount = { wabaId: string; phoneNumberId: string; displayPhone: string | null };

export async function connectWhatsApp(input: { wabaId: string; phoneNumberId: string; accessToken: string }) {
  const query = `mutation ConnectWhatsApp($input: ConnectWhatsAppInput!) {
    connectWhatsApp(input: $input) { wabaId phoneNumberId displayPhone }
  }`;
  return (await gql<{ connectWhatsApp: WhatsAppAccount }>(query, { input })).connectWhatsApp;
}
