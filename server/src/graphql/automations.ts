import { getAutomationSettings, updateAutomationSettings, REPLY_MAX, workingHoursOf } from '../services/automations.js';
import { authed } from './shared.js';

export const typeDefs = /* GraphQL */ `
  "Settings → Company settings → Simple automations"
  type AutomationSettings {
    enabled: Boolean!
    "Day numbers, 0 = Sunday … 6 = Saturday"
    workingDays: [Int!]!
    "HH:MM in timeZone"
    workStart: String!
    workEnd: String!
    "Each working day (Monday first) with its own hours"
    workingHours: [WorkingDay!]!
    replyInHoursEnabled: Boolean!
    replyInHours: String!
    replyOutHoursEnabled: Boolean!
    replyOutHours: String!
    "A chat gets at most one automatic reply in this many hours"
    cooldownHours: Int!
    routingEnabled: Boolean!
    "specific (one teammate gets every new chat) | round_robin (chosen teammates in turn) | unassigned"
    routingMode: String!
    "Members new chats are assigned to, in turn"
    routingMemberIds: [ID!]!
    routingOnlineOnly: Boolean!
    "The workspace's default time zone (Workspace preferences), which working hours use"
    timeZone: String!
    "When the last automatic reply was sent in this workspace"
    lastAutoReplyAt: DateTime
    "Variables a reply can use: the workspace's contact properties (standard and custom, as named here) and company details, e.g. {{contact.first_name}}"
    variables: [AutomationVariable!]!
    replyMaxLength: Int!
  }

  type WorkingDay {
    "0 = Sunday … 6 = Saturday"
    day: Int!
    "HH:MM in timeZone; an end of 23:59 means until midnight"
    start: String!
    end: String!
  }

  input WorkingDayInput {
    day: Int!
    start: String!
    end: String!
  }

  type AutomationVariable {
    key: String!
    label: String!
  }

  input AutomationSettingsInput {
    enabled: Boolean
    workingDays: [Int!]
    workStart: String
    workEnd: String
    "Every working day with its hours; days left out are closed"
    workingHours: [WorkingDayInput!]
    replyInHoursEnabled: Boolean
    replyInHours: String
    replyOutHoursEnabled: Boolean
    replyOutHours: String
    cooldownHours: Int
    routingEnabled: Boolean
    routingMode: String
    routingMemberIds: [ID!]
    routingOnlineOnly: Boolean
  }

  extend type Query {
    "Owners and admins"
    automationSettings: AutomationSettings!
  }

  extend type Mutation {
    "Owners and admins; only the fields sent change"
    updateAutomationSettings(input: AutomationSettingsInput!): AutomationSettings!
  }
`;

const shape = (s: Awaited<ReturnType<typeof getAutomationSettings>>) => ({
  ...s,
  workingDays: s.workingDays.split(',').filter(Boolean).map(Number),
  workingHours: workingHoursOf(s),
  replyMaxLength: REPLY_MAX,
});

export const resolvers = {
  Query: {
    automationSettings: authed(async (_args: unknown, auth) => shape(await getAutomationSettings(auth))),
  },
  Mutation: {
    updateAutomationSettings: authed(async ({ input }: { input: unknown }, auth) => shape(await updateAutomationSettings(auth, input))),
  },
};
