import { listPresence } from '../presence.js';
import { authed } from './shared.js';

export const typeDefs = /* GraphQL */ `
  "Live presence of a workspace member (from their Socket.IO connections, not stored)"
  type Presence {
    userId: ID!
    "online | away (no activity for a few minutes) | offline"
    status: String!
    lastActiveAt: DateTime
  }

  extend type Query {
    "Everyone in your workspace who has been connected since the server started; anyone missing is offline"
    presence: [Presence!]!
  }
`;

export const resolvers = {
  Query: {
    presence: authed(async (_args, { workspaceId }) => listPresence(workspaceId)),
  },
};
