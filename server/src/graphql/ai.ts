import { aiConfigured, conversationSummary, generateConversationSummary, suggestReply } from '../services/ai.js';
import { authed } from './shared.js';

export const typeDefs = /* GraphQL */ `
  "A chat's AI Summary of the whole chat (one per chat; Regenerate adds the messages after its checkpoint)"
  type ConversationSummary {
    id: ID!
    conversationId: ID!
    summary: String!
    "The checkpoint: the last message the summary covers (Regenerate continues after it)"
    lastMessageId: ID
    createdAt: DateTime!
    updatedAt: DateTime!
    createdBy: ID
    updatedBy: ID
    createdByName: String
    updatedByName: String
    "false once newer messages came in after it was made"
    upToDate: Boolean!
    "After Generate/Regenerate: how many messages that run added (0: nothing new, the AI wasn't asked). null when read"
    addedMessages: Int
  }

  extend type Query {
    "Whether the AI Assistant is set up on this server (OPENROUTER_API_KEY or ANTHROPIC_API_KEY)"
    aiConfigured: Boolean!
    "The chat's saved AI Summary (owners, admins and supervisors); null before the first one"
    conversationSummary(conversationId: ID!): ConversationSummary
  }

  extend type Mutation {
    "Write the chat's AI Summary, or rewrite it (Regenerate). Owners, admins and supervisors"
    generateConversationSummary(conversationId: ID!): ConversationSummary!
    "A reply suggestion to edit; nothing is saved or sent (send it with sendTextMessage after the person confirms)"
    suggestReply(conversationId: ID!): String!
  }
`;

export const resolvers = {
  Query: {
    aiConfigured: authed(async () => aiConfigured()),
    conversationSummary: authed(({ conversationId }: { conversationId: string }, auth) => conversationSummary(auth, conversationId)),
  },
  Mutation: {
    generateConversationSummary: authed(({ conversationId }: { conversationId: string }, auth) => generateConversationSummary(auth, conversationId)),
    suggestReply: authed(({ conversationId }: { conversationId: string }, auth) => suggestReply(auth, conversationId)),
  },
};
