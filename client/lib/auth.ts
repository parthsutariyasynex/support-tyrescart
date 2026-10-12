import { gql } from './api';

const ME_FIELDS = `
  user { id name email }
  workspace { id name whatsapp { displayPhone phoneNumberId wabaId } }
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
