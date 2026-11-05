import { connectWhatsApp, getWhatsAppAccount } from '../services/settings.js';
import { listWhatsAppConnectionLogs } from '../services/whatsappAudit.js';
import { authed } from './shared.js';

export const typeDefs = /* GraphQL */ `
  "Connected WhatsApp number. The access token is write-only and never returned."
  type WhatsAppAccount {
    displayPhone: String
    phoneNumberId: String!
    wabaId: String!
    "The checks done with Meta before saving (only on connectWhatsApp's answer)"
    checks: [WhatsAppCheck!]
  }

  "One check done with Meta when connecting a number"
  type WhatsAppCheck {
    name: String!
    ok: Boolean!
    detail: String!
  }

  input ConnectWhatsAppInput {
    wabaId: String!
    phoneNumberId: String!
    accessToken: String!
  }

  "One WhatsApp Connect / Update / Replace attempt or restore (never holds tokens or secrets)"
  type WhatsAppConnectionLog {
    id: ID!
    "UTC; shown in Asia/Dubai"
    createdAt: DateTime!
    workspaceId: ID!
    workspaceName: String
    actorId: ID
    actorName: String
    actorEmail: String
    "connect | replace | update | restore"
    action: String!
    "success | failed"
    status: String!
    "settings | api | script"
    source: String!
    previousDisplayPhone: String
    previousPhoneNumberId: String
    previousWabaId: String
    newDisplayPhone: String
    phoneNumberId: String
    wabaId: String
    "JSON: [{ name, ok, detail }], the checks with Meta that ran"
    checks: String
    checksPassed: Int!
    backupCreated: Boolean!
    backupId: String
    errorCode: String
    errorReason: String
  }

  type WhatsAppConnectionLogOption {
    id: ID!
    name: String!
    email: String
  }

  type WhatsAppConnectionLogPage {
    nodes: [WhatsAppConnectionLog!]!
    total: Int!
    "Workspaces you're an admin of (the workspace filter)"
    workspaces: [WhatsAppConnectionLogOption!]!
    "People who appear in these workspaces' activity (the admin filter)"
    admins: [WhatsAppConnectionLogOption!]!
  }

  input WhatsAppConnectionLogFilter {
    workspaceId: ID
    actorId: ID
    "success | failed"
    status: String
    "YYYY-MM-DD, days in Asia/Dubai (inclusive)"
    from: String
    to: String
  }

  extend type Query {
    whatsappAccount: WhatsAppAccount
    "Admins only: WhatsApp connection activity of the workspaces you're an admin of, newest first. first: at most 100"
    whatsappConnectionLogs(filter: WhatsAppConnectionLogFilter, first: Int, offset: Int): WhatsAppConnectionLogPage!
  }

  extend type Mutation {
    "Runs 7 checks with Meta, then connects (or replaces) this workspace's number; a replaced number is backed up"
    connectWhatsApp(input: ConnectWhatsAppInput!): WhatsAppAccount!
  }
`;

export const resolvers = {
  Query: {
    whatsappAccount: authed((_args, { workspaceId }) => getWhatsAppAccount(workspaceId)),
    whatsappConnectionLogs: authed(({ filter, first, offset }: { filter?: Record<string, string | null> | null; first?: number | null; offset?: number | null }, auth) =>
      listWhatsAppConnectionLogs(auth, filter ?? {}, first ?? 50, offset ?? 0),
    ),
  },
  Mutation: {
    connectWhatsApp: authed(({ input }: { input: unknown }, auth) => connectWhatsApp(auth, input)),
  },
};
