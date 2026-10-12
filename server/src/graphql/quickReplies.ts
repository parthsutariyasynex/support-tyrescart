import { listQuickReplies } from '../services/quickReplies.js';
import { authed } from './shared.js';

export const typeDefs = /* GraphQL */ `
  "A canned reply offered when typing / in the message box (WhatsApp Business-style quick replies)"
  type QuickReply {
    id: ID!
    "Typed after /, e.g. tyrescart"
    shortcut: String!
    "The message text it inserts"
    description: String
    "e.g. car_tyres, car_services, car_insurance, battery, other"
    category: String
    sortOrder: Int!
  }

  extend type Query {
    "This workspace's enabled quick replies. search: case-insensitive partial match on shortcut, text or category (best shortcut matches first). first: 1-100 (default 50)"
    quickReplies(search: String, first: Int): [QuickReply!]!
  }
`;

export const resolvers = {
  Query: {
    quickReplies: authed(({ search, first }: { search?: string | null; first?: number | null }, { workspaceId }) =>
      listQuickReplies(workspaceId, { search: search ?? undefined, first: first ?? undefined }),
    ),
  },
};
