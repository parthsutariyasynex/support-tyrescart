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
    me { ${ME_FIELDS} }
  }
`;

export async function login(input: { email: string; password: string }) {
  return (await gql<{ login: { token: string } }>(LOGIN, { input })).login;
}

export async function register(input: { name: string; email: string; password: string; workspaceName: string }) {
  return (await gql<{ register: { token: string } }>(REGISTER, { input })).register;
}

export async function fetchMe<T>() {
  return (await gql<{ me: T }>(ME)).me;
}
