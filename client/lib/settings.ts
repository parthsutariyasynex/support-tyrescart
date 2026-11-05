import { gql } from './api';

export type WhatsAppCheck = { name: string; ok: boolean; detail: string };
export type WhatsAppAccount = { wabaId: string; phoneNumberId: string; displayPhone: string | null; checks?: WhatsAppCheck[] | null };

// Admins only. The server runs 7 checks with Meta first and saves nothing if one fails (the error names it).
export async function connectWhatsApp(input: { wabaId: string; phoneNumberId: string; accessToken: string }) {
  const query = `mutation ConnectWhatsApp($input: ConnectWhatsAppInput!) {
    connectWhatsApp(input: $input) { wabaId phoneNumberId displayPhone checks { name ok detail } }
  }`;
  return (await gql<{ connectWhatsApp: WhatsAppAccount }>(query, { input })).connectWhatsApp;
}

// Settings → WhatsApp connection activity (admins only): the audit trail of Connect / Update / Replace and restores
export type WhatsAppConnectionLog = {
  id: string;
  createdAt: string;
  workspaceId: string;
  workspaceName: string | null;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  action: 'connect' | 'replace' | 'update' | 'restore';
  status: 'success' | 'failed';
  source: 'settings' | 'api' | 'script';
  previousDisplayPhone: string | null;
  previousPhoneNumberId: string | null;
  previousWabaId: string | null;
  newDisplayPhone: string | null;
  phoneNumberId: string | null;
  wabaId: string | null;
  checks: WhatsAppCheck[] | null;
  checksPassed: number;
  backupCreated: boolean;
  backupId: string | null;
  errorCode: string | null;
  errorReason: string | null;
};
export type WhatsAppLogOption = { id: string; name: string; email: string | null };
export type WhatsAppLogFilter = { workspaceId?: string; actorId?: string; status?: string; from?: string; to?: string };

export async function fetchWhatsAppConnectionLogs(filter: WhatsAppLogFilter, first: number, offset: number) {
  const query = `query WhatsAppConnectionLogs($filter: WhatsAppConnectionLogFilter, $first: Int, $offset: Int) {
    whatsappConnectionLogs(filter: $filter, first: $first, offset: $offset) {
      total
      workspaces { id name }
      admins { id name email }
      nodes {
        id createdAt workspaceId workspaceName actorId actorName actorEmail action status source
        previousDisplayPhone previousPhoneNumberId previousWabaId newDisplayPhone phoneNumberId wabaId
        checks checksPassed backupCreated backupId errorCode errorReason
      }
    }
  }`;
  // Empty filter values mean "any"
  const clean = Object.fromEntries(Object.entries(filter).filter(([, v]) => v));
  type Raw = Omit<WhatsAppConnectionLog, 'checks'> & { checks: string | null };
  const page = (
    await gql<{ whatsappConnectionLogs: { total: number; workspaces: WhatsAppLogOption[]; admins: WhatsAppLogOption[]; nodes: Raw[] } }>(query, { filter: clean, first, offset })
  ).whatsappConnectionLogs;
  return {
    ...page,
    nodes: page.nodes.map((n): WhatsAppConnectionLog => {
      let checks: WhatsAppCheck[] | null = null;
      try {
        checks = n.checks ? JSON.parse(n.checks) : null;
      } catch {}
      return { ...n, checks };
    }),
  };
}
