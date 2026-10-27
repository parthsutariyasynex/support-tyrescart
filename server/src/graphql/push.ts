import { pushConfigured, registerPushDevice, unregisterPushDevice } from '../services/push.js';
import { authed } from './shared.js';

export const typeDefs = /* GraphQL */ `
  extend type Query {
    "Whether this server sends push notifications (Firebase configured); the app registers its device only then"
    pushConfigured: Boolean!
  }

  extend type Mutation {
    "The signed-in person's phone, for push notifications in this workspace (platform: android | ios). false: push isn't configured on the server (nothing stored)"
    registerPushDevice(token: String!, platform: String!): Boolean!
    "Signing out on a phone: no more push notifications to it for this person"
    unregisterPushDevice(token: String!): Boolean!
  }
`;

export const resolvers = {
  Query: {
    pushConfigured: authed(async () => pushConfigured()),
  },
  Mutation: {
    registerPushDevice: authed((input: { token: string; platform: string }, auth) => registerPushDevice(auth, input)),
    unregisterPushDevice: authed(({ token }: { token: string }, auth) => unregisterPushDevice(auth, token)),
  },
};
