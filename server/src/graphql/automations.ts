import { getAutomationSettings, updateAutomationSettings, REPLY_MAX, workingHoursOf } from '../services/automations.js';
import { followUpTemplateStatus } from '../services/followUps.js';
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
    "Follow-up after 24 hours: on by default (while Simple automations is on). Sends the approved template named follow_up or follow_up_… (see followUpTemplate)"
    followUpEnabled: Boolean!
    "Since when follow-ups are being sent; only chats whose 24 hours run out after this get one"
    followUpActiveSince: DateTime
    "When the last follow-up was sent in this workspace"
    lastFollowUpAt: DateTime
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

  "The follow-up template found right now (read live from Meta), or why there's none"
  type FollowUpTemplateStatus {
    template: FollowUpTemplate
    problem: String
  }

  type FollowUpTemplate {
    name: String!
    language: String!
    "Its header and body text, with the {{variables}}"
    text: String!
    variables: [FollowUpVariable!]!
    "Other follow_up templates of this number not used (the first by name, then language, is used)"
    others: Int!
  }

  type FollowUpVariable {
    "header | body"
    part: String!
    "The template's variable, e.g. 1 for {{1}}"
    name: String!
    "What fills it, e.g. contact.first_name"
    key: String!
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
    followUpEnabled: Boolean
  }

  extend type Query {
    "Owners and admins"
    automationSettings: AutomationSettings!
    "Owners and admins: the template the 24-hour follow-up uses (follow_up or follow_up_…, approved at Meta)"
    followUpTemplate: FollowUpTemplateStatus!
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
    followUpTemplate: authed((_args: unknown, auth) => followUpTemplateStatus(auth)),
  },
  Mutation: {
    updateAutomationSettings: authed(async ({ input }: { input: unknown }, auth) => shape(await updateAutomationSettings(auth, input))),
  },
};
