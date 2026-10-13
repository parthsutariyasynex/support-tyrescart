import {
  createJoinLink,
  inviteMember,
  joinLinkInfo,
  joinWorkspace,
  listMembers,
  removeMember,
  updateMemberRole,
} from '../services/members.js';
import { withMe } from './auth.js';
import { authed, run } from './shared.js';

export const typeDefs = /* GraphQL */ `
  "Someone in the workspace, as admins see them (with email)"
  type TeamMember {
    userId: ID!
    name: String!
    email: String!
    "owner | admin | supervisor | agent ('owner' is the workspace creator: an admin who can't be changed or removed)"
    role: String!
    isOwner: Boolean!
    canManageLabels: Boolean!
    "active: can sign in | invited: added by an admin and hasn't chosen a password yet"
    status: String!
  }

  input InviteMemberInput {
    name: String!
    email: String!
    "admin | supervisor | agent"
    role: String!
  }

  type InviteResult {
    member: TeamMember!
    "true: a new account was created and emailed a link to choose a password; false: an existing account was added"
    invited: Boolean!
    "false if the invite email couldn't be sent (they can still use Forgot password)"
    emailSent: Boolean!
  }

  "A team signup link: whoever opens it can join this workspace as an Agent"
  type JoinLink {
    token: String!
    expiresAt: DateTime!
  }

  type JoinLinkInfo {
    workspaceName: String!
  }

  extend type Query {
    "Admins only"
    members: [TeamMember!]!
    "Public: which workspace a signup link joins"
    joinLinkInfo(token: String!): JoinLinkInfo!
  }

  extend type Mutation {
    "Admins only. New email: creates the account and emails an invite. Existing account: adds it to this workspace."
    inviteMember(input: InviteMemberInput!): InviteResult!
    "Admins only; not for the owner or yourself"
    updateMemberRole(userId: ID!, role: String!): TeamMember!
    "Admins only; not for the owner or yourself. Their account stays; they lose access to this workspace at once."
    removeMember(userId: ID!): ID!
    "Admins only"
    createJoinLink: JoinLink!
    "Signed in with an existing account: join the link's workspace as an Agent (or keep your role if already a member)"
    joinWorkspace(token: String!): AuthPayload!
  }
`;

export const resolvers = {
  Query: {
    members: authed((_args, auth) => listMembers(auth)),
    joinLinkInfo: (_: unknown, { token }: { token: string }) => run(() => joinLinkInfo(token)),
  },
  Mutation: {
    inviteMember: authed(({ input }: { input: unknown }, auth) => inviteMember(auth, input)),
    updateMemberRole: authed(({ userId, role }: { userId: string; role: string }, auth) => updateMemberRole(auth, userId, role)),
    removeMember: authed(({ userId }: { userId: string }, auth) => removeMember(auth, userId)),
    createJoinLink: authed((_args, auth) => createJoinLink(auth)),
    joinWorkspace: authed(async ({ token }: { token: string }, auth) => withMe(await joinWorkspace(auth, token))),
  },
};
