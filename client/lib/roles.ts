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

// People listed in the Assign menu: the workspace owner (so they can take chats and see them in My Chats),
// Supervisors and Agents. Other Admins manage and aren't listed.
export const ASSIGN_LIST_ROLES = ['owner', 'supervisor', 'agent'] as const;

// The Assign menu's People: this workspace's owner, Supervisors and Agents, by name
export function assignableMembers<M extends { name: string; role: string }>(members: M[]): M[] {
  return members
    .filter((m) => (ASSIGN_LIST_ROLES as readonly string[]).includes(m.role))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Assign list checkboxes (assign, reassign, unassign) are shown only to people the server says may manage
// assignments: owners and admins. Supervisors and agents never see them, and nothing loaded (null) hides them too.
// The server enforces the same rule on every request; this only decides what to draw.
export const showsAssignCheckboxes = (permissions: { canManageAssignments: boolean } | null | undefined) =>
  permissions?.canManageAssignments === true;

// Assign dropdown, below the People: assignee names that aren't a current member (never linked, or linked to someone
// since removed). Such a name is stale, so it is listed only while it still holds chats (an admin can then move
// them); once it holds none it disappears. Names linked to a listed member are shown as that person instead.
export function otherAssigneesToList<A extends { userId: string | null; conversationCount: number }>(
  assignees: A[],
  members: { id: string }[],
): A[] {
  return assignees.filter((a) => !(a.userId && members.some((m) => m.id === a.userId)) && a.conversationCount > 0);
}
