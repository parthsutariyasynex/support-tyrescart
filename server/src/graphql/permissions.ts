import { getPermissions, setLabelPermission } from '../services/permissions.js';
import { authed, requireAuth, type Context } from './shared.js';

export const typeDefs = /* GraphQL */ `
  type MemberPermissions {
    userId: ID!
    "owner | admin | agent"
    role: String!
    "Owners and admins always can; agents only when granted"
    canManageLabels: Boolean!
  }

  extend type Me {
    "owner | admin | agent"
    role: String!
    "Can create, rename, recolour and delete labels and assignees"
    canManageLabels: Boolean!
  }

  extend type Mutation {
    "Owners and admins only: let an agent manage labels and assignees (or take it away)"
    setLabelPermission(userId: ID!, canManageLabels: Boolean!): MemberPermissions!
  }
`;

export const resolvers = {
  Me: {
    role: async (_me: unknown, _args: unknown, ctx: Context) => (await getPermissions(requireAuth(ctx))).role,
    canManageLabels: async (_me: unknown, _args: unknown, ctx: Context) =>
      (await getPermissions(requireAuth(ctx))).canManageLabels,
  },
  Mutation: {
    setLabelPermission: authed(({ userId, canManageLabels }: { userId: string; canManageLabels: boolean }, auth) =>
      setLabelPermission(auth, userId, canManageLabels),
    ),
  },
};
