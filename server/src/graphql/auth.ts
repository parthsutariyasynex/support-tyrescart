import { verifyToken } from '../auth.js';
import { getMe, login, register } from '../services/auth.js';
import { authed, run, type Context } from './shared.js';

export const typeDefs = /* GraphQL */ `
  type User {
    id: ID!
    name: String!
    email: String!
  }

  type Workspace {
    id: ID!
    name: String!
    createdAt: DateTime!
    whatsapp: WhatsAppAccount
  }

  type AuthPayload {
    token: String!
    user: User!
    workspace: Workspace!
  }

  type Me {
    user: User!
    workspace: Workspace!
  }

  input RegisterInput {
    name: String!
    email: String!
    password: String!
    workspaceName: String!
  }

  input LoginInput {
    email: String!
    password: String!
  }

  extend type Query {
    me: Me!
  }

  extend type Mutation {
    register(input: RegisterInput!): AuthPayload!
    login(input: LoginInput!): AuthPayload!
  }
`;

async function withMe(result: { token: string; userId: string }) {
  const { workspaceId } = verifyToken(result.token);
  return { token: result.token, ...(await getMe({ userId: result.userId, workspaceId })) };
}

export const resolvers = {
  Query: {
    me: authed((_args, auth) => getMe(auth)),
  },
  Mutation: {
    register: (_: unknown, { input }: { input: unknown }) => run(async () => withMe(await register(input))),
    login: (_: unknown, { input }: { input: unknown }, ctx: Context) =>
      run(async () => withMe(await login(input, ctx.ip))),
  },
};
