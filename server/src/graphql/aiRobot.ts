import { aiRobotRuns, aiRobotStatus, aiRobotTestChats, getAiRobotSettings, stopAiRobotInChat, testAiRobot, updateAiRobotSettings } from '../services/aiRobot.js';
import { authed } from './shared.js';

export const typeDefs = /* GraphQL */ `
  "Settings → AI Robot (owners and admins only): automatic replies in unassigned chats"
  type AiRobotSettings {
    enabled: Boolean!
    "draft (writes replies into the chat's AI Robot tab, sends nothing) | live (sends to the customer)"
    mode: String!
    "First reply when nobody from the team has answered the customer for this many minutes"
    firstReplyMins: Int!
    "Once the robot is answering: wait this many seconds for more quick messages (0 = reply at once)"
    groupSeconds: Int!
    "any | in_hours | out_hours (working hours from Simple automations)"
    hoursRule: String!
    "Robot replies per chat in 24 hours before it hands the chat over"
    maxRepliesPerDay: Int!
    "0 to 1: replies the AI is less sure about are not sent (handover instead)"
    minConfidence: Float!
    webSearch: Boolean!
    "Sent when the robot hands a chat over; null = defaultHandoverMessage"
    handoverMessage: String
    defaultHandoverMessage: String!
    "Sent instead to customers who write in Arabic (when handoverMessage is empty)"
    defaultHandoverMessageArabic: String!
    "Facts about the business the robot may use"
    companyInfo: String
    "One per line"
    bannedPhrases: String
    "false: AI_ROBOT_ENABLED=false on this server, so it never runs"
    serverEnabled: Boolean!
    "false: no AI service set up on this server"
    aiConfigured: Boolean!
    "false: no Tyrescart catalogue on this server (TYRESCART_GRAPHQL_URL): the robot never quotes prices"
    catalogueConfigured: Boolean!
    "false: web search is not available on this server (needs OpenRouter)"
    webSearchAvailable: Boolean!
    updatedAt: DateTime
  }

  input AiRobotSettingsInput {
    enabled: Boolean
    mode: String
    firstReplyMins: Int
    groupSeconds: Int
    hoursRule: String
    maxRepliesPerDay: Int
    minConfidence: Float
    webSearch: Boolean
    "Empty or null: the default message"
    handoverMessage: String
    companyInfo: String
    bannedPhrases: String
  }

  "Where the AI Robot stands in one chat"
  type AiRobotStatus {
    conversationId: ID!
    "off | waiting | active | stopped | handover"
    state: String!
    "What to show, e.g. 'Stopped: a team member replied in this chat'"
    label: String!
    "When it will reply if nobody from the team does (waiting/active)"
    dueAt: DateTime
    mode: String!
  }

  "One AI Robot decision in a chat"
  type AiRobotRun {
    id: ID!
    "reply | draft | order (order details collected, chat handed over) | handover | blocked | failed"
    action: String!
    reason: String
    confidence: Float
    "The reply it wrote but didn't send (draft mode)"
    draft: String
    "What the AI looked up for this decision, e.g. 'search_tyres 245/40 R18: 5 of 9'"
    tools: [String!]!
    "The customer message it answered, and the message it sent"
    inMessageId: String
    messageId: String
    model: String!
    durationMs: Int!
    createdAt: DateTime!
  }

  "What the robot would answer in a chat now (nothing saved or sent)"
  type AiRobotTest {
    "reply | order (it would send the order summary and hand over) | handover"
    action: String!
    "The message the customer would get"
    reply: String!
    "The AI's own reply, also when a check stopped it"
    aiReply: String
    reason: String
    "The safety check it failed, if any"
    blockedBy: String
    confidence: Float
    model: String!
    "Tools the AI called (catalogue, web search) and what they found"
    tools: [String!]!
    "Products (tyrescart:<id>) and pages (web:<url>) the AI says it used"
    sources: [String!]!
  }

  extend type Query {
    aiRobotSettings: AiRobotSettings!
    aiRobotStatus(conversationId: ID!): AiRobotStatus!
    aiRobotRuns(conversationId: ID!, limit: Int): [AiRobotRun!]!
    "Owners and admins: recent chats to try Test the robot on"
    aiRobotTestChats: [AiRobotTestChat!]!
  }

  type AiRobotTestChat {
    conversationId: ID!
    name: String!
    status: String!
    assigned: Boolean!
    robotState: String
    lastCustomerMessage: String!
  }

  extend type Mutation {
    "Owners and admins only"
    updateAiRobotSettings(input: AiRobotSettingsInput!): AiRobotSettings!
    "Stops the robot in this chat (until the chat is closed and reopened)"
    stopAiRobot(conversationId: ID!): AiRobotStatus!
    "Owners and admins: what the robot would answer in this chat now; nothing is saved or sent"
    testAiRobot(conversationId: ID!): AiRobotTest!
  }
`;

export const resolvers = {
  Query: {
    aiRobotSettings: authed((_args, auth) => getAiRobotSettings(auth)),
    aiRobotStatus: authed(({ conversationId }: { conversationId: string }, auth) => aiRobotStatus(auth, conversationId)),
    aiRobotRuns: authed(({ conversationId, limit }: { conversationId: string; limit?: number | null }, auth) => aiRobotRuns(auth, conversationId, limit ?? 20)),
    aiRobotTestChats: authed((_args, auth) => aiRobotTestChats(auth)),
  },
  Mutation: {
    updateAiRobotSettings: authed(({ input }: { input: unknown }, auth) => updateAiRobotSettings(auth, input)),
    stopAiRobot: authed(({ conversationId }: { conversationId: string }, auth) => stopAiRobotInChat(auth, conversationId)),
    testAiRobot: authed(({ conversationId }: { conversationId: string }, auth) => testAiRobot(auth, conversationId)),
  },
};
