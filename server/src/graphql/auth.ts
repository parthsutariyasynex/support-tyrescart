import { settingsOf } from '../services/workspaceSettings.js';
import { verifyToken } from '../auth.js';
import { changePassword, getMe, login, register } from '../services/auth.js';
import { requestPasswordReset, resetPassword } from '../services/passwordReset.js';
import { createWorkspace, listWorkspaces, renameWorkspace, switchWorkspace } from '../services/workspaces.js';
import type { GraphQLResolveInfo } from 'graphql';
import { authed, operationOf, run, type Context } from './shared.js';

export const typeDefs = /* GraphQL */ `
  type User {
    id: ID!
    name: String!
    email: String!
    "Your own phone number (international format) and job title, from Settings → General (only ever returned to you)"
    phone: String
    jobTitle: String
    "Your time zone for dates and times (IANA, e.g. Asia/Dubai); null = the app default"
    timeZone: String
    "When your profile picture last changed (GET /me/avatar); null = no picture"
    avatarUpdatedAt: DateTime
    "Settings → WhatsApp QR code: the first message filled in for customers (only returned to you)"
    qrMessage: String
  }

  type Workspace {
    id: ID!
    name: String!
    createdAt: DateTime!
    whatsapp: WhatsAppAccount
    "Workspace preferences (Settings → Company settings)"
    settings: WorkspaceSettings!
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

  "Without joinToken: creates a workspace you own. With joinToken (a team signup link): joins that workspace as an Agent."
  input RegisterInput {
    name: String!
    email: String!
    password: String!
    workspaceName: String
    joinToken: String
  }

  input LoginInput {
    email: String!
    password: String!
    "Optional: open this workspace if you're a member of it (e.g. the last one you used); otherwise your first"
    workspaceId: ID
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
    "owner | admin | supervisor | agent"
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
    "Owners and admins: rename this workspace (the company name in Settings → Company details); returns the saved name"
    renameWorkspace(name: String!): String!
    "Returns a token for another workspace the current user is a member of"
    switchWorkspace(id: ID!): AuthPayload!
    "Change your own password (current one required; 8-72 characters with a letter and a number). Other sessions are signed out; returns a fresh token for this one."
    changeMyPassword(currentPassword: String!, newPassword: String!): AuthPayload!
  }
`;

export async function withMe(result: { token: string; userId: string }) {
  const { workspaceId } = verifyToken(result.token);
  return { token: result.token, ...(await getMe({ userId: result.userId, workspaceId })) };
}

export const resolvers = {
  Workspace: {
    settings: (w: { id: string }) => settingsOf(w.id),
  },
  Query: {
    me: authed((_args, auth) => getMe(auth)),
    workspaces: authed((_args, auth) => listWorkspaces(auth)),
  },
  Mutation: {
    register: (_: unknown, { input }: { input: unknown }, _ctx: Context, info: GraphQLResolveInfo) =>
      run(async () => withMe(await register(input)), operationOf(info)),
    login: (_: unknown, { input }: { input: unknown }, ctx: Context, info: GraphQLResolveInfo) =>
      run(async () => withMe(await login(input, ctx.ip)), operationOf(info)),
    requestPasswordReset: (_: unknown, { email }: { email: string }, ctx: Context, info: GraphQLResolveInfo) =>
      run(() => requestPasswordReset({ email }, ctx.ip), operationOf(info)),
    resetPassword: (_: unknown, { input }: { input: unknown }, _ctx: Context, info: GraphQLResolveInfo) =>
      run(() => resetPassword(input), operationOf(info)),
    createWorkspace: authed(async ({ name }: { name: string }, auth) => withMe(await createWorkspace(auth, { name }))),
    switchWorkspace: authed(async ({ id }: { id: string }, auth) => withMe(await switchWorkspace(auth, id))),
    renameWorkspace: authed(async ({ name }: { name: string }, auth) => (await renameWorkspace(auth, { name })).name),
    changeMyPassword: authed(async (input: { currentPassword: string; newPassword: string }, auth) => withMe(await changePassword(auth, input))),
  },
};
