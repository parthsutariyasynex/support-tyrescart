import { gql } from './api';

const ME_FIELDS = `
  user { id name email phone jobTitle timeZone avatarUpdatedAt qrMessage }
  workspace { id name whatsapp { displayPhone phoneNumberId wabaId } settings { defaultTimeZone defaultCountry businessDayStartHour } }
`;

export const LOGIN = `
  mutation Login($input: LoginInput!) {
    login(input: $input) { token ${ME_FIELDS} }
  }
`;

export const REGISTER = `
  mutation Register($input: RegisterInput!) {
    register(input: $input) { token ${ME_FIELDS} }
  }
`;

export const ME = `
  query Me {
    me { ${ME_FIELDS} role }
  }
`;

// workspaceId: open this workspace if the account belongs to it (the last one used); otherwise its first
export async function login(input: { email: string; password: string; workspaceId?: string | null }) {
  return (await gql<{ login: { token: string } }>(LOGIN, { input })).login;
}

// workspaceName: create your own workspace (you own it). joinToken: join a team from its signup link as an Agent.
export async function register(input: { name: string; email: string; password: string; workspaceName?: string; joinToken?: string }) {
  return (await gql<{ register: { token: string } }>(REGISTER, { input })).register;
}

export async function fetchMe<T>() {
  return (await gql<{ me: T }>(ME)).me;
}

export type WorkspaceSummary = { id: string; name: string; role: string; createdAt?: string };

export async function fetchWorkspaces() {
  return (await gql<{ workspaces: WorkspaceSummary[] }>(`query Workspaces { workspaces { id name role createdAt } }`)).workspaces;
}

// Both return a token for the target workspace (you become owner of a new one)
export async function createWorkspace(name: string) {
  const query = `mutation CreateWorkspace($name: String!) { createWorkspace(name: $name) { token } }`;
  return (await gql<{ createWorkspace: { token: string } }>(query, { name })).createWorkspace;
}

export async function switchWorkspace(id: string) {
  const query = `mutation SwitchWorkspace($id: ID!) { switchWorkspace(id: $id) { token } }`;
  return (await gql<{ switchWorkspace: { token: string } }>(query, { id })).switchWorkspace;
}

// Always resolves true for a valid email, whether or not it has an account
export async function requestPasswordReset(email: string) {
  await gql(`mutation RequestReset($email: String!) { requestPasswordReset(email: $email) }`, { email });
}

export async function resetPassword(token: string, password: string) {
  await gql(`mutation ResetPassword($input: ResetPasswordInput!) { resetPassword(input: $input) }`, { input: { token, password } });
}

// Signed in: change your own password. Stores the returned token: other sessions are signed out, this one continues.
export async function changeMyPassword(currentPassword: string, newPassword: string) {
  const query = `mutation ChangeMyPassword($c: String!, $n: String!) { changeMyPassword(currentPassword: $c, newPassword: $n) { token } }`;
  return (await gql<{ changeMyPassword: { token: string } }>(query, { c: currentPassword, n: newPassword })).changeMyPassword;
}

// Settings → My profile: change your own name. Tells the app shell to reload who you are (header, menus).
export const ME_CHANGED_EVENT = 'app:me-changed';
export async function updateMyName(name: string) {
  const r = (await gql<{ updateMyName: { name: string } }>(`mutation UpdateMyName($n: String!) { updateMyName(name: $n) { name } }`, { n: name })).updateMyName;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(ME_CHANGED_EVENT));
  return r;
}

// Settings → Company details: rename this workspace (owners/admins); the app shell reloads to show it
export async function renameWorkspace(name: string) {
  const r = (await gql<{ renameWorkspace: string }>(`mutation RenameWorkspace($n: String!) { renameWorkspace(name: $n) }`, { n: name })).renameWorkspace;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(ME_CHANGED_EVENT));
  return r;
}

// "First name" / "Last name" from a full name (the first word, then the rest) and back
export function splitName(full: string) {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
}
export const joinName = (first: string, last: string) => [first.trim(), last.trim()].filter(Boolean).join(' ');

// Settings → General: name, phone number, job title and time zone (only what's sent changes; empty clears)
export async function updateMyProfile(input: { name?: string; phone?: string; jobTitle?: string; timeZone?: string; qrMessage?: string }) {
  const r = (
    await gql<{ updateMyProfile: { name: string; phone: string | null; jobTitle: string | null; timeZone: string | null } }>(
      `mutation UpdateMyProfile($i: MyProfileInput!) { updateMyProfile(input: $i) { name phone jobTitle timeZone } }`,
      { i: input },
    )
  ).updateMyProfile;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(ME_CHANGED_EVENT));
  return r;
}
