import { connectWhatsApp, getWhatsAppAccount } from '../services/settings.js';
import { authed } from './shared.js';

export const typeDefs = /* GraphQL */ `
  "Connected WhatsApp number. The access token is write-only and never returned."
  type WhatsAppAccount {
    displayPhone: String
    phoneNumberId: String!
    wabaId: String!
  }

  input ConnectWhatsAppInput {
    wabaId: String!
    phoneNumberId: String!
    accessToken: String!
  }

  extend type Query {
    whatsappAccount: WhatsAppAccount
  }

  extend type Mutation {
    "Verifies the credentials with Meta, then connects (or updates) this workspace's number"
    connectWhatsApp(input: ConnectWhatsAppInput!): WhatsAppAccount!
  }
`;

export const resolvers = {
  Query: {
    whatsappAccount: authed((_args, { workspaceId }) => getWhatsAppAccount(workspaceId)),
  },
  Mutation: {
    connectWhatsApp: authed(({ input }: { input: unknown }, { workspaceId }) => connectWhatsApp(workspaceId, input)),
  },
};
