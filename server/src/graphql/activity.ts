import { listContactActivity, listConversationActivity, listNotifications, markNotificationsSeen, unreadTotal } from '../services/activity.js';
import { getPermissions } from '../services/permissions.js';
import { clearedAt } from '../services/conversationClear.js';
import { authed } from './shared.js';

export const typeDefs = /* GraphQL */ `
  "Something that happened in a chat: closed/reopened, assigned, labelled, message edited/deleted/restored, customer message"
  type Activity {
    id: ID!
    "conversation_closed | conversation_reopened | assigned | unassigned | label_added | label_removed | message_edited | message_deleted | message_restored | message_received"
    type: String!
    conversationId: ID
    "Agent who did it; null for customer messages"
    actorId: ID
    actorName: String
    "The customer of that chat"
    contactName: String
    "JSON details, e.g. {\\"label\\":\\"VIP\\",\\"color\\":\\"#25d366\\"}"
    data: String
    createdAt: DateTime!
  }

  type NotificationFeed {
    "Newest first; excludes your own actions"
    items: [Activity!]!
    "How many arrived since you last opened the bell"
    unseen: Int!
    seenAt: DateTime
  }

  extend type Query {
    "Timeline for a chat, oldest first (customer messages are left out; they're bubbles)"
    conversationActivity(conversationId: ID!): [Activity!]!
    "Contact details page: everything for this customer's chat, newest first (customer messages, profile changes and remarks included)"
    contactActivity(contactId: ID!): [Activity!]!
    notifications: NotificationFeed!
    "Unread customer messages across the workspace"
    unreadTotal: Int!
  }

  extend type Mutation {
    markNotificationsSeen: Boolean!
  }
`;

export const resolvers = {
  Query: {
    contactActivity: authed(async ({ contactId }: { contactId: string }, auth) => {
      await getPermissions(auth); // members only
      return listContactActivity(auth.workspaceId, contactId);
    }),
    // Like messages: a chat you cleared hides its earlier history from you only
    conversationActivity: authed(async ({ conversationId }: { conversationId: string }, { workspaceId, userId }) =>
      listConversationActivity(workspaceId, conversationId, undefined, await clearedAt(userId, conversationId)),
    ),
    notifications: authed((_args, auth) => listNotifications(auth)),
    unreadTotal: authed((_args, { workspaceId }) => unreadTotal(workspaceId)),
  },
  Mutation: {
    markNotificationsSeen: authed((_args, auth) => markNotificationsSeen(auth)),
  },
};
