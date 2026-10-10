import { prisma } from '../prisma.js';
import {
  addConversationLabel,
  createLabel,
  deleteLabel,
  listLabels,
  removeConversationLabel,
  updateLabel,
} from '../services/labels.js';
import { authed } from './shared.js';

export const typeDefs = /* GraphQL */ `
  "WhatsApp Business-style label, shared across the workspace"
  type Label {
    id: ID!
    name: String!
    "Hex colour, e.g. #25d366"
    color: String!
    "Conversations that currently have this label"
    conversationCount: Int!
    createdAt: DateTime!
  }

  input CreateLabelInput {
    name: String!
    color: String!
  }

  input UpdateLabelInput {
    name: String
    color: String
  }

  extend type Query {
    "Sorted by name"
    labels: [Label!]!
  }

  # Creating, editing and deleting labels needs label-management permission (see Me.canManageLabels)
  extend type Mutation {
    createLabel(input: CreateLabelInput!): Label!
    updateLabel(id: ID!, input: UpdateLabelInput!): Label!
    "Removes the label from every conversation. Returns the deleted id."
    deleteLabel(id: ID!): ID!
    addConversationLabel(conversationId: ID!, labelId: ID!): Conversation!
    removeConversationLabel(conversationId: ID!, labelId: ID!): Conversation!
  }
`;

type LabelParent = { id: string; conversationCount?: number };
type AssignArgs = { conversationId: string; labelId: string };

export const resolvers = {
  Query: {
    labels: authed((_args, { workspaceId }) => listLabels(workspaceId)),
  },
  Mutation: {
    createLabel: authed(({ input }: { input: unknown }, auth) => createLabel(auth, input)),
    updateLabel: authed(({ id, input }: { id: string; input: Record<string, unknown> }, auth) =>
      // GraphQL sends explicit nulls for omitted fields; drop them so they stay unchanged
      updateLabel(auth, id, Object.fromEntries(Object.entries(input).filter(([, v]) => v != null))),
    ),
    deleteLabel: authed(({ id }: { id: string }, auth) => deleteLabel(auth, id)),
    addConversationLabel: authed(({ conversationId, labelId }: AssignArgs, { workspaceId, userId }) =>
      addConversationLabel(workspaceId, conversationId, labelId, userId),
    ),
    removeConversationLabel: authed(({ conversationId, labelId }: AssignArgs, { workspaceId, userId }) =>
      removeConversationLabel(workspaceId, conversationId, labelId, userId),
    ),
  },
  Label: {
    // Labels nested in a conversation don't carry the count; count on demand
    conversationCount: (l: LabelParent) =>
      l.conversationCount ?? prisma.conversationLabel.count({ where: { labelId: l.id } }),
  },
};
