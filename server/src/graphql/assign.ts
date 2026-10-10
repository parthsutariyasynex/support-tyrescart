import { prisma } from '../prisma.js';
import {
  assignConversation,
  createAssignee,
  deleteAssignee,
  listAssignees,
  updateAssignee,
} from '../services/assign.js';
import { authed } from './shared.js';

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
  }

  input CreateAssigneeInput {
    name: String!
    color: String!
  }

  input UpdateAssigneeInput {
    name: String
    color: String
  }

  extend type Query {
    "Sorted by name"
    assignees: [Assignee!]!
  }

  # Creating, editing and deleting assignees needs label-management permission (see Me.canManageLabels)
  extend type Mutation {
    createAssignee(input: CreateAssigneeInput!): Assignee!
    updateAssignee(id: ID!, input: UpdateAssigneeInput!): Assignee!
    "Their conversations become unassigned. Returns the deleted id."
    deleteAssignee(id: ID!): ID!
    "Pass assigneeId: null to unassign"
    assignConversation(conversationId: ID!, assigneeId: ID): Conversation!
  }
`;

type AssigneeParent = { id: string; conversationCount?: number };

export const resolvers = {
  Query: {
    assignees: authed((_args, { workspaceId }) => listAssignees(workspaceId)),
  },
  Mutation: {
    createAssignee: authed(({ input }: { input: unknown }, auth) => createAssignee(auth, input)),
    updateAssignee: authed(({ id, input }: { id: string; input: Record<string, unknown> }, auth) =>
      // GraphQL sends explicit nulls for omitted fields; drop them so they stay unchanged
      updateAssignee(auth, id, Object.fromEntries(Object.entries(input).filter(([, v]) => v != null))),
    ),
    deleteAssignee: authed(({ id }: { id: string }, auth) => deleteAssignee(auth, id)),
    assignConversation: authed(
      ({ conversationId, assigneeId }: { conversationId: string; assigneeId?: string | null }, { workspaceId, userId }) =>
        assignConversation(workspaceId, conversationId, assigneeId ?? null, userId),
    ),
  },
  Assignee: {
    // An assignee nested in a conversation doesn't carry the count; count on demand
    conversationCount: (a: AssigneeParent) =>
      a.conversationCount ?? prisma.conversation.count({ where: { assignedToId: a.id } }),
  },
};
