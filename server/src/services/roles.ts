// Workspace roles, stored per membership in Member.role (one user can have a different role in each workspace).
// 'owner' is whoever created the workspace: an Admin who can't be demoted or removed, so a workspace always
// keeps someone who can manage it.
//   Admin (owner, admin): users, roles and system settings, plus everything below
//   Supervisor: team chats and assignments (assign/reassign anyone, labels and assignees)
//   Agent: customer conversations; can take an unassigned chat or release their own, and manage labels
//          and assignees only if an Admin grants it (Member.canManageLabels)
export const ROLES = ['owner', 'admin', 'supervisor', 'agent'] as const;
export type Role = (typeof ROLES)[number];

// Roles an Admin can give someone ('owner' is never assigned; it comes from creating the workspace)
export const ASSIGNABLE_ROLES = ['admin', 'supervisor', 'agent'] as const;

// Self-registration through a team signup link, and anyone added without a role
export const DEFAULT_ROLE: Role = 'agent';

export const isAdminRole = (role: string) => role === 'owner' || role === 'admin';
export const isSupervisorOrAbove = (role: string) => isAdminRole(role) || role === 'supervisor';

// Who chats can be assigned to directly as a person: every member, admins included, so anyone can find their
// chats in My Chats. (Who may assign is separate: see assignConversation.)
export const ASSIGNABLE_TO_ROLES = ['owner', 'admin', 'supervisor', 'agent'] as const;
// Role colours, also used for the assignee created the first time a person is assigned a chat
export const ROLE_COLORS: Record<string, string> = { admin: '#6d28d9', owner: '#6d28d9', supervisor: '#1d4ed8', agent: '#047857' };
