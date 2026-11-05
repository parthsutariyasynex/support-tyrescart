import { addTyreSize, listTyreSizes } from '../services/tyreSizes.js';
import { authed } from './shared.js';

export const typeDefs = /* GraphQL */ `
  "A tyre size added to the list, and the whole list after it"
  type AddTyreSizeResult {
    "As saved: capitals, no spaces (205/55R16)"
    size: String!
    sizes: [String!]!
  }

  extend type Query {
    "The vehicle form's tyre sizes (server/config/tyre-sizes.json)"
    tyreSizes: [String!]!
  }

  extend type Mutation {
    "Adds a size to the list file. Errors: BAD_USER_INPUT (not a tyre size), DUPLICATE (already listed)"
    addTyreSize(size: String!): AddTyreSizeResult!
  }
`;

export const resolvers = {
  Query: {
    tyreSizes: authed(() => listTyreSizes()),
  },
  Mutation: {
    addTyreSize: authed(({ size }: { size: string }) => addTyreSize(size)),
  },
};
