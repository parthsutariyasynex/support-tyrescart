import { verifyToken } from '../auth.js';
import { getMe, login, register } from '../services/auth.js';
import { requestPasswordReset, resetPassword } from '../services/passwordReset.js';
import { createWorkspace, listWorkspaces, switchWorkspace } from '../services/workspaces.js';
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

  input ResetPasswordInput {
    "The token from the emailed reset link"
    token: String!
    password: String!
  }

  "A workspace the current user belongs to"
  type WorkspaceSummary {
    id: ID!
    name: String!
    "owner | admin | agent"
    role: String!
    createdAt: DateTime!
  }

  extend type Query {
    me: Me!
    "Every workspace the current user belongs to, oldest first"
    workspaces: [WorkspaceSummary!]!
  }

  extend type Mutation {
    register(input: RegisterInput!): AuthPayload!
    login(input: LoginInput!): AuthPayload!
    "Emails a password reset link if the address has an account. Always returns true, so it can't reveal which emails exist."
    requestPasswordReset(email: String!): Boolean!
    "Sets a new password using an emailed link. Signs out every existing session."
    resetPassword(input: ResetPasswordInput!): Boolean!
    "Create a workspace owned by the current user. Returns a token for the new workspace."
    createWorkspace(name: String!): AuthPayload!
    "Returns a token for another workspace the current user is a member of"
    switchWorkspace(id: ID!): AuthPayload!
  }
`;

async function withMe(result: { token: string; userId: string }) {
  const { workspaceId } = verifyToken(result.token);
  return { token: result.token, ...(await getMe({ userId: result.userId, workspaceId })) };
}

export const resolvers = {
  Query: {
    me: authed((_args, auth) => getMe(auth)),
    workspaces: authed((_args, auth) => listWorkspaces(auth)),
  },
  Mutation: {
    register: (_: unknown, { input }: { input: unknown }) => run(async () => withMe(await register(input))),
    login: (_: unknown, { input }: { input: unknown }, ctx: Context) =>
      run(async () => withMe(await login(input, ctx.ip))),
    requestPasswordReset: (_: unknown, { email }: { email: string }, ctx: Context) =>
      run(() => requestPasswordReset({ email }, ctx.ip)),
    resetPassword: (_: unknown, { input }: { input: unknown }) => run(() => resetPassword(input)),
    createWorkspace: authed(async ({ name }: { name: string }, auth) => withMe(await createWorkspace(auth, { name }))),
    switchWorkspace: authed(async ({ id }: { id: string }, auth) => withMe(await switchWorkspace(auth, id))),
  },
};
