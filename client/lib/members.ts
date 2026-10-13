import { gql } from './api';

// Team management (admins only on the server)
// status: 'active' (can sign in), 'invited' (added by an admin, no password chosen yet) or 'inactive' (deactivated here)
export type TeamMember = { userId: string; name: string; email: string; role: string; isOwner: boolean; canManageLabels: boolean; active: boolean; status: string };
const FIELDS = 'userId name email role isOwner canManageLabels active status';

export async function fetchMembers() {
  return (await gql<{ members: TeamMember[] }>(`query TeamMembers { members { ${FIELDS} } }`)).members;
}

// password: optional first password set by the admin (only ever sent over the API; the server stores a hash)
export async function inviteMember(input: { name: string; email: string; role: string; password?: string }) {
  const query = `mutation InviteMember($input: InviteMemberInput!) { inviteMember(input: $input) { invited emailSent created member { ${FIELDS} } } }`;
  return (await gql<{ inviteMember: { invited: boolean; emailSent: boolean; created: boolean; member: TeamMember } }>(query, { input })).inviteMember;
}

// Admins only: rename a member and/or set them a new password (signs them out everywhere)
export async function updateMember(userId: string, input: { name?: string; password?: string }) {
  const query = `mutation UpdateMember($userId: ID!, $input: UpdateMemberInput!) { updateMember(userId: $userId, input: $input) { ${FIELDS} } }`;
  return (await gql<{ updateMember: TeamMember }>(query, { userId, input })).updateMember;
}

// Admins only: deactivate (can't sign in here, sessions cut, nothing deleted) or reactivate
export async function setMemberActive(userId: string, active: boolean) {
  const query = `mutation SetMemberActive($userId: ID!, $active: Boolean!) { setMemberActive(userId: $userId, active: $active) { ${FIELDS} } }`;
  return (await gql<{ setMemberActive: TeamMember }>(query, { userId, active })).setMemberActive;
}

// Admins only; never the owner or yourself
export async function updateMemberRole(userId: string, role: string) {
  const query = `mutation UpdateMemberRole($userId: ID!, $role: String!) { updateMemberRole(userId: $userId, role: $role) { ${FIELDS} } }`;
  return (await gql<{ updateMemberRole: TeamMember }>(query, { userId, role })).updateMemberRole;
}

export async function removeMember(userId: string) {
  await gql(`mutation RemoveMember($userId: ID!) { removeMember(userId: $userId) }`, { userId });
}

export async function createJoinLink() {
  return (await gql<{ createJoinLink: { token: string; expiresAt: string } }>(`mutation JoinLink { createJoinLink { token expiresAt } }`))
    .createJoinLink;
}

// Public: the workspace a signup link joins
export async function fetchJoinLinkInfo(token: string) {
  return (await gql<{ joinLinkInfo: { workspaceName: string } }>(`query JoinLinkInfo($t: String!) { joinLinkInfo(token: $t) { workspaceName } }`, { t: token }))
    .joinLinkInfo;
}

// Signed in: join the link's workspace (as Agent); returns a token for it
export async function joinWorkspace(token: string) {
  return (await gql<{ joinWorkspace: { token: string } }>(`mutation JoinWorkspace($t: String!) { joinWorkspace(token: $t) { token } }`, { t: token }))
    .joinWorkspace;
}
