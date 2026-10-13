import { gql } from './api';

// Team management (admins only on the server)
// status: 'active' (can sign in) or 'invited' (added by an admin, no password chosen yet)
export type TeamMember = { userId: string; name: string; email: string; role: string; isOwner: boolean; canManageLabels: boolean; status: string };
const FIELDS = 'userId name email role isOwner canManageLabels status';

export async function fetchMembers() {
  return (await gql<{ members: TeamMember[] }>(`query TeamMembers { members { ${FIELDS} } }`)).members;
}

export async function inviteMember(input: { name: string; email: string; role: string }) {
  const query = `mutation InviteMember($input: InviteMemberInput!) { inviteMember(input: $input) { invited emailSent member { ${FIELDS} } } }`;
  return (await gql<{ inviteMember: { invited: boolean; emailSent: boolean; member: TeamMember } }>(query, { input })).inviteMember;
}

// Admins only: let a supervisor assign and unassign chats (or take it away)
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
