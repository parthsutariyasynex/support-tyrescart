// Workspace roles as the server stores them (Member.role). 'owner' is the workspace creator: shown as
// Admin, and can't be demoted or removed. The server enforces every permission; this only decides what
// the UI offers.
export type Role = 'owner' | 'admin' | 'supervisor' | 'agent';
export const ASSIGNABLE_ROLES = ['admin', 'supervisor', 'agent'] as const;

export const ROLE_STYLES = {
  admin: { label: 'Admin', color: '#6D28D9' },
  supervisor: { label: 'Supervisor', color: '#1D4ED8' },
  agent: { label: 'Agent', color: '#047857' },
} as const;

// owner -> admin; anything unknown shows as Agent (the least access)
export function roleStyle(role: string | null | undefined) {
  if (role === 'owner' || role === 'admin') return ROLE_STYLES.admin;
  if (role === 'supervisor') return ROLE_STYLES.supervisor;
  return ROLE_STYLES.agent;
}

export const isAdminRole = (role?: string | null) => role === 'owner' || role === 'admin';
// Assign/reassign anyone, manage labels and assignees
export const canManageAssignments = (role?: string | null) => isAdminRole(role) || role === 'supervisor';

// People listed in the Assign menu: the workspace owner (so they can take chats and see them in My Chats),
// Supervisors and Agents. Other Admins manage and aren't listed.
export const ASSIGN_LIST_ROLES = ['owner', 'supervisor', 'agent'] as const;

// The Assign menu's People: this workspace's owner, Supervisors and Agents, by name
export function assignableMembers<M extends { name: string; role: string }>(members: M[]): M[] {
  return members
    .filter((m) => (ASSIGN_LIST_ROLES as readonly string[]).includes(m.role))
    .sort((a, b) => a.name.localeCompare(b.name));
}
