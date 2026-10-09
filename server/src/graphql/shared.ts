import { GraphQLError, GraphQLScalarType, Kind } from 'graphql';
import type { AuthPayload } from '../auth.js';
import { AppError } from '../services/errors.js';

export type Context = { auth: AuthPayload | null; ip: string };

export const typeDefs = /* GraphQL */ `
  "ISO-8601 date-time string"
  scalar DateTime

  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  type Query
  type Mutation
`;

export const resolvers = {
  DateTime: new GraphQLScalarType({
    name: 'DateTime',
    serialize: (v) => (v instanceof Date ? v.toISOString() : String(v)),
    parseValue: (v) => new Date(String(v)),
    parseLiteral: (ast) => (ast.kind === Kind.STRING ? new Date(ast.value) : null),
  }),
};

// Turn service errors into GraphQL errors with a stable `extensions.code`.
// Anything else is masked by Yoga as "Unexpected error." so internals never leak.
export async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw new GraphQLError(err.message, { extensions: { code: err.code } });
    throw err;
  }
}

export function requireAuth(ctx: Context) {
  if (!ctx.auth) throw new GraphQLError('Unauthorized', { extensions: { code: 'UNAUTHENTICATED' } });
  return ctx.auth;
}

// Resolver for protected fields: auth check + error mapping, hands the caller's workspaceId to `fn`
export function authed<A, R>(fn: (args: A, auth: AuthPayload) => Promise<R>) {
  return (_: unknown, args: A, ctx: Context) => run(() => fn(args, requireAuth(ctx)));
}

export function toConnection<T>(page: { nodes: T[]; hasNextPage: boolean; endCursor: string | null }) {
  return { nodes: page.nodes, pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor } };
}
