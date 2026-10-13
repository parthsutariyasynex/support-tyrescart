import { prisma } from '../prisma.js';
import { AppError } from '../services/errors.js';
import {
  assignConversation,
  assignConversationToMember,
  claimConversation,
  createAssignee,
  deleteAssignee,
  listAssignees,
  listWorkspaceMembers,
  updateAssignee,
} from '../services/assign.js';
import { authed, requireAuth, type Context } from './shared.js';

export const typeDefs = /* GraphQL */ `
  "Who a conversation is assigned to: a name and colour managed per workspace, like labels"
  type Assignee {
    id: ID!
    name: String!
    "Hex colour, e.g. #25d366"
    color: String!
    "Conversations currently assigned to this assignee"
    conversationCount: Int!
    createdAt: DateTime!
    "The workspace member this assignee is, if linked (enables 'Assigned to me' and assignment notifications)"
    userId: ID
    user: WorkspaceMember
  }

  "Someone in the current workspace"
  type WorkspaceMember {
    id: ID!
    name: String!
    email: String!
    "owner | admin | supervisor | agent"
    role: String!
  }

  input CreateAssigneeInput {
    name: String!
    color: String!
    "Link to a workspace member (optional)"
    userId: ID
  }

  input UpdateAssigneeInput {
    name: String
    color: String
    "Link to a workspace member; pass null to unlink, omit to keep"
    userId: ID
  }

  extend type Query {
    "Sorted by name"
    assignees: [Assignee!]!
    "Everyone in the workspace, sorted by name (for linking assignees)"
    workspaceMembers: [WorkspaceMember!]!
  }

  # Creating, editing and deleting assignees needs label-management permission (see Me.canManageLabels)
  extend type Mutation {
    createAssignee(input: CreateAssigneeInput!): Assignee!
    updateAssignee(id: ID!, input: UpdateAssigneeInput!): Assignee!
    "Their conversations become unassigned. Returns the deleted id."
    deleteAssignee(id: ID!): ID!
    "Pass assigneeId: null to unassign. Assigning the current assignee again changes nothing. memberId (instead of assigneeId): assign to that Supervisor or Agent, using the assignee linked to them (created on first use)."
    assignConversation(conversationId: ID!, assigneeId: ID, memberId: ID): Conversation!
    "Assign to Me (New Leads): take an unassigned chat for yourself. Fails with ALREADY_ASSIGNED if someone else has it."
    claimConversation(conversationId: ID!): Conversation!
  }
`;

type AssigneeParent = { id: string; conversationCount?: number; workspaceId?: string; userId?: string | null };

export const resolvers = {
  Query: {
    assignees: authed((_args, { workspaceId }) => listAssignees(workspaceId)),
    workspaceMembers: authed((_args, { workspaceId }) => listWorkspaceMembers(workspaceId)),
  },
  Mutation: {
    createAssignee: authed(({ input }: { input: unknown }, auth) => createAssignee(auth, input)),
    updateAssignee: authed(({ id, input }: { id: string; input: Record<string, unknown> }, auth) =>
      // Clients send explicit nulls for fields they leave alone; drop them so they stay unchanged.
      // userId is the exception: null there means "unlink".
      updateAssignee(auth, id, Object.fromEntries(Object.entries(input).filter(([k, v]) => v != null || k === 'userId'))),
    ),
    deleteAssignee: authed(({ id }: { id: string }, auth) => deleteAssignee(auth, id)),
    claimConversation: authed(({ conversationId }: { conversationId: string }, auth) => claimConversation(auth, conversationId)),
    assignConversation: authed(
      async (
        { conversationId, assigneeId, memberId }: { conversationId: string; assigneeId?: string | null; memberId?: string | null },
        auth,
      ) => {
        if (assigneeId && memberId) throw new AppError('Pass either assigneeId or memberId, not both', 400, 'BAD_USER_INPUT');
        return memberId
          ? assignConversationToMember(auth, conversationId, memberId)
          : assignConversation(auth.workspaceId, conversationId, assigneeId ?? null, auth.userId);
      },
    ),
  },
  Assignee: {
    // An assignee nested in a conversation doesn't carry the count; count on demand
    conversationCount: (a: AssigneeParent) =>
      a.conversationCount ?? prisma.conversation.count({ where: { assignedToId: a.id } }),
    userId: (a: AssigneeParent) => a.userId ?? null,
    // Only while they're still in this workspace
    user: async (a: AssigneeParent, _args: unknown, ctx: Context) => {
      if (!a.userId) return null;
      const member = await prisma.member.findUnique({
        where: { userId_workspaceId: { userId: a.userId, workspaceId: requireAuth(ctx).workspaceId } },
        include: { user: { select: { id: true, name: true, email: true } } },
      });
      return member && { id: member.user.id, name: member.user.name, email: member.user.email, role: member.role };
    },
  },
};
