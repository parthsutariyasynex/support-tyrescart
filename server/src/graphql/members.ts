import {
  createJoinLink,
  inviteMember,
  joinLinkInfo,
  joinWorkspace,
  listMembers,
  removeMember,
  setMemberActive,
  updateMember,
  updateMyName,
  updateMyProfile,
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
    "false: deactivated in this workspace by an admin"
    active: Boolean!
    "active: can sign in | invited: added by an admin and hasn't chosen a password yet | inactive: deactivated here"
    status: String!
  }

  input InviteMemberInput {
    name: String!
    email: String!
    "admin | supervisor | agent"
    role: String!
    "Optional first password (8-72 characters with a letter and a number). Without it, an invite email asks them to choose one."
    password: String
  }

  type InviteResult {
    member: TeamMember!
    "true: a new account was emailed a link to choose a password; false: it got the given password, or an existing account was added"
    invited: Boolean!
    "false if the invite email couldn't be sent (they can still use Forgot password)"
    emailSent: Boolean!
    "true: a new account was created; false: an existing account was added to this workspace"
    created: Boolean!
  }

  input UpdateMemberInput {
    name: String
    "A new password for them (same rule as above); signs them out everywhere"
    password: String
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

  input MyProfileInput {
    name: String
    phone: String
    jobTitle: String
    "IANA time zone, e.g. Asia/Dubai; empty = the app default"
    timeZone: String
    "Settings → WhatsApp QR code; empty = none"
    qrMessage: String
  }

  extend type Mutation {
    "Admins only. New email: creates the account and emails an invite. Existing account: adds it to this workspace."
    inviteMember(input: InviteMemberInput!): InviteResult!
    "Admins only; not for the owner or yourself"
    updateMemberRole(userId: ID!, role: String!): TeamMember!
    "Admins only: change a member's name or set them a new password (not the owner's, not your own password)"
    updateMember(userId: ID!, input: UpdateMemberInput!): TeamMember!
    "Settings → My profile: change your own name (any role)"
    updateMyName(name: String!): TeamMember!
    "Settings → General → Profile: your name, phone number, job title and time zone (only the fields sent change; empty clears)"
    updateMyProfile(input: MyProfileInput!): User!
    "Admins only; not for the owner or yourself. false: they can't sign in here, sessions are cut, nothing is deleted."
    setMemberActive(userId: ID!, active: Boolean!): TeamMember!
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
    updateMyProfile: authed((input: { input: unknown }, auth) => updateMyProfile(auth, input.input)),
    updateMyName: authed(({ name }: { name: string }, auth) => updateMyName(auth, name)),
    updateMemberRole: authed(({ userId, role }: { userId: string; role: string }, auth) => updateMemberRole(auth, userId, role)),
    updateMember: authed(({ userId, input }: { userId: string; input: unknown }, auth) => updateMember(auth, userId, input)),
    setMemberActive: authed(({ userId, active }: { userId: string; active: boolean }, auth) => setMemberActive(auth, userId, active)),
    removeMember: authed(({ userId }: { userId: string }, auth) => removeMember(auth, userId)),
    createJoinLink: authed((_args, auth) => createJoinLink(auth)),
    joinWorkspace: authed(async ({ token }: { token: string }, auth) => withMe(await joinWorkspace(auth, token))),
  },
};
