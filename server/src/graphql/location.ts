import { geocoderEnabled, reversePlace, searchPlaces } from '../services/geocoding.js';
import { sendLocationMessage } from '../services/location.js';
import { getLiveLocation, myActiveLiveLocations, startLiveLocation, stopLiveLocation, updateLiveLocation } from '../services/liveLocation.js';
import { authed } from './shared.js';

// Location messages: send a pin, search places/addresses, and live location (a link the customer follows)
export const typeDefs = /* GraphQL */ `
  "A place or address from the Location search (OpenStreetMap data)"
  type Place {
    latitude: Float!
    longitude: Float!
    name: String
    address: String!
  }

  type LivePosition {
    latitude: Float!
    longitude: Float!
    "Metres (as the browser reported it)"
    accuracy: Float
    at: DateTime!
  }

  "A live location being shared in a chat (ends at 'until', or when stopped)"
  type LiveLocation {
    messageId: ID!
    conversationId: ID!
    userId: ID!
    sharerName: String!
    startedAt: DateTime!
    until: DateTime!
    stoppedAt: DateTime
    active: Boolean!
    position: LivePosition
  }

  type LiveLocationStarted {
    message: Message!
    live: LiveLocation!
  }

  input SendLocationInput {
    conversationId: ID!
    latitude: Float!
    longitude: Float!
    "The place's name and address, when known (shown under the pin, in the app and in WhatsApp)"
    name: String
    address: String
    replyToId: ID
  }

  input StartLiveLocationInput {
    conversationId: ID!
    "15, 60 or 480"
    minutes: Int!
    latitude: Float!
    longitude: Float!
    accuracy: Float
  }

  input LivePositionInput {
    latitude: Float!
    longitude: Float!
    accuracy: Float
  }

  extend type Query {
    "Whether place search is available on this server"
    locationSearchEnabled: Boolean!
    "Places and addresses matching the text (search when asked, not as you type)"
    searchPlaces(query: String!, language: String): [Place!]!
    "The address at a point on the map; null when there is none"
    reversePlace(latitude: Float!, longitude: Float!, language: String): Place
    "A live location message's sharing (null when unknown, e.g. after a server restart: it has ended)"
    liveLocation(messageId: ID!): LiveLocation
    "Your own live locations still being shared in this workspace"
    myLiveLocations: [LiveLocation!]!
  }

  extend type Mutation {
    "A location pin; only inside the 24-hour customer service window"
    sendLocationMessage(input: SendLocationInput!): Message!
    "Share your live location for 15 minutes, 1 hour or 8 hours: the customer gets a link that follows it"
    startLiveLocation(input: StartLiveLocationInput!): LiveLocationStarted!
    "Where you are now, while sharing (only the person sharing)"
    updateLiveLocation(messageId: ID!, position: LivePositionInput!): LiveLocation!
    "Stop sharing (the person sharing, or an admin)"
    stopLiveLocation(messageId: ID!): LiveLocation!
  }
`;

export const resolvers = {
  Query: {
    locationSearchEnabled: authed(async () => geocoderEnabled()),
    searchPlaces: authed(({ query, language }: { query: string; language?: string | null }) => searchPlaces(query, language)),
    reversePlace: authed(({ latitude, longitude, language }: { latitude: number; longitude: number; language?: string | null }) => reversePlace(latitude, longitude, language)),
    liveLocation: authed(async ({ messageId }: { messageId: string }, auth) => getLiveLocation(auth, messageId)),
    myLiveLocations: authed(async (_args: unknown, auth) => myActiveLiveLocations(auth)),
  },
  Mutation: {
    sendLocationMessage: authed(({ input }: { input: { conversationId: string } & Record<string, unknown> }, { workspaceId, userId }) => {
      const { conversationId, ...rest } = input;
      return sendLocationMessage(workspaceId, conversationId, rest, userId);
    }),
    startLiveLocation: authed(({ input }: { input: unknown }, auth) => startLiveLocation(auth, input)),
    updateLiveLocation: authed(async ({ messageId, position }: { messageId: string; position: unknown }, auth) => updateLiveLocation(auth, messageId, position)),
    stopLiveLocation: authed(({ messageId }: { messageId: string }, auth) => stopLiveLocation(auth, messageId)),
  },
};
