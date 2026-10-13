import { prisma } from '../prisma.js';
import { AppError } from '../services/errors.js';
import {
  assignConversation,
  assignConversationToMember,
  assigneeInclude,
  claimConversation,
  listAssignees,
  listWorkspaceMembers,
  toAssignee,
} from '../services/assign.js';
import { authed } from './shared.js';

export const typeDefs = /* GraphQL */ `
  "Who a conversation is assigned to: a workspace member, shown with their name and role colour (id = the member id)"
  type Assignee {
    id: ID!
    name: String!
    "Hex colour of their role, e.g. #047857 for agents"
    color: String!
    "Conversations currently assigned to this member"
    conversationCount: Int!
    "The person's user id (enables 'Assigned to me' and assignment notifications)"
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

  extend type Query {
    "Every active member of the workspace as an assignee, sorted by name"
    assignees: [Assignee!]!
    "Everyone active in the workspace, sorted by name"
    workspaceMembers: [WorkspaceMember!]!
  }

  extend type Mutation {
    "Admins only. assigneeId: the member id (null = unassign). memberId: the person's user id instead. Assigning the current holder again changes nothing."
    assignConversation(conversationId: ID!, assigneeId: ID, memberId: ID): Conversation!
    "Assign to Me (New Leads): take an unassigned chat for yourself. Fails with ALREADY_ASSIGNED if someone else has it."
    claimConversation(conversationId: ID!): Conversation!
  }
`;

type AssigneeParent = { id: string; conversationCount?: number; userId?: string | null; user?: unknown };

export const resolvers = {
  Query: {
    assignees: authed((_args, { workspaceId }) => listAssignees(workspaceId)),
    workspaceMembers: authed((_args, { workspaceId }) => listWorkspaceMembers(workspaceId)),
  },
  Mutation: {
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
    // Nested in a conversation the assignee carries no count or user details; look them up on demand
    conversationCount: (a: AssigneeParent) =>
      a.conversationCount ?? prisma.conversation.count({ where: { assignedToId: a.id } }),
    userId: (a: AssigneeParent) => a.userId ?? null,
    user: async (a: AssigneeParent) => {
      if (a.user !== undefined) return a.user;
      const member = await prisma.member.findUnique({ where: { id: a.id }, include: assigneeInclude });
      return member ? toAssignee(member).user : null;
    },
  },
};
