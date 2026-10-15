import { gql } from './api';
import type { WorkspaceMember } from './assignees';

// Collaborators on a chat (teammates added besides the assignee)
export async function fetchCollaborators(conversationId: string) {
  return (await gql<{ conversation: { collaborators: WorkspaceMember[] } }>(`query Collaborators($id: ID!) { conversation(id: $id) { collaborators { id name email role } } }`, { id: conversationId }))
    .conversation.collaborators;
}
export async function addCollaborators(conversationId: string, userIds: string[]) {
  return (await gql<{ addCollaborators: WorkspaceMember[] }>(`mutation Add($c: ID!, $u: [ID!]!) { addCollaborators(conversationId: $c, userIds: $u) { id name email role } }`, { c: conversationId, u: userIds })).addCollaborators;
}
export async function removeCollaborator(conversationId: string, userId: string) {
  return (await gql<{ removeCollaborator: WorkspaceMember[] }>(`mutation Remove($c: ID!, $u: ID!) { removeCollaborator(conversationId: $c, userId: $u) { id name email role } }`, { c: conversationId, u: userId })).removeCollaborator;
}

// Team members offered in the panel: everyone not already a collaborator, matching the search (name or email)
export function addableMembers<M extends { id: string; name: string; email: string }>(members: M[], collaborators: { id: string }[], query: string): M[] {
  const term = query.trim().toLowerCase();
  return members
    .filter((m) => !collaborators.some((c) => c.id === m.id))
    .filter((m) => !term || m.name.toLowerCase().includes(term) || m.email.toLowerCase().includes(term))
    .sort((a, b) => a.name.localeCompare(b.name));
}
