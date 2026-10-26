import { GraphQLError, GraphQLScalarType, Kind, type GraphQLResolveInfo } from 'graphql';
import type { AuthPayload } from '../auth.js';
import { AppError } from '../services/errors.js';
import { logEvent } from '../services/logging.js';

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

// The GraphQL field being resolved, for the logs: its name, whether it's a query or a mutation, and the chat or
// message it is about (only these ids from its variables, never the rest: they hold messages and passwords)
export type Operation = { name: string; type: string; conversationId?: string | null; messageId?: string | null };
const idIn = (v: any, key: string): string | null => {
  const found = v?.[key] ?? v?.input?.[key];
  return typeof found === 'string' && found ? found.slice(0, 64) : null;
};
export const operationOf = (info: GraphQLResolveInfo | undefined): Operation | undefined =>
  info
    ? {
        name: info.fieldName,
        type: info.operation.operation,
        conversationId: idIn(info.variableValues, 'conversationId'),
        messageId: idIn(info.variableValues, 'messageId'),
      }
    : undefined;

// What a mutation answered, for the logs: the saved message's id and status (and why it failed), no text
function resultOf(result: unknown) {
  const r = result as any;
  if (!r || typeof r !== 'object' || typeof r.id !== 'string') return undefined;
  return { id: r.id, ...(typeof r.status === 'string' ? { status: r.status } : {}), ...(typeof r.error === 'string' && r.error ? { error: r.error } : {}) };
}

// Mutations are logged whatever the outcome (refusals as WARNING with their code); queries only when something
// unexpected breaks. Arguments are never logged (they hold messages, passwords and customer details).
function logOperation(op: Operation | undefined, started: number, err?: unknown, result?: unknown) {
  const type = op?.type ?? 'unknown';
  const name = op?.name ?? 'unknown';
  const durationMs = Date.now() - started;
  const data = { operation: name, operationType: type };
  const ids = { conversationId: op?.conversationId ?? null, messageId: op?.messageId ?? null };
  if (err === undefined) {
    if (type === 'mutation') {
      const answer = resultOf(result);
      void logEvent({ level: 'SUCCESS', category: 'graphql', event: 'graphql.mutation', message: `${name} succeeded${answer?.status ? ` (message ${answer.status})` : ''}`, reason: `A user did "${name}" in the web app`, direction: 'in', outcome: 'succeeded', durationMs, ...ids, ...(answer?.status ? { messageId: answer.id } : {}), response: answer ?? null, data });
    }
    return;
  }
  const code = err instanceof AppError ? err.code : err instanceof GraphQLError ? (err.extensions?.code as string | undefined) : undefined;
  if (code) {
    if (type === 'mutation')
      void logEvent({ level: 'WARNING', category: 'graphql', event: 'graphql.mutation', message: `${name} refused: ${(err as Error).message}`, reason: `A user tried "${name}" in the web app and it was refused (${code})`, direction: 'in', outcome: 'refused', errorCode: code, errorDetails: (err as Error).message, durationMs, ...ids, data });
    return;
  }
  void logEvent({
    level: 'ERROR',
    category: 'graphql',
    event: `graphql.${type}`,
    message: `${name} failed: ${(err as Error)?.message ?? String(err)}`,
    direction: 'in',
    outcome: 'failed',
    reason: `The web app called "${name}" and the server hit an unexpected error`,
    errorDetails: (err as Error)?.message ?? String(err),
    durationMs,
    ...ids,
    data: { ...data, error: err, stack: (err as Error)?.stack?.split('\n').slice(0, 6).join('\n') },
  });
}

// Turn service errors into GraphQL errors with a stable `extensions.code`.
// Anything else is masked by Yoga as "Unexpected error." so internals never leak.
// op: the field being resolved (operationOf(info)), so the outcome is logged under its name
export async function run<T>(fn: () => Promise<T>, op?: Operation): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    logOperation(op, started, undefined, result);
    return result;
  } catch (err) {
    logOperation(op, started, err);
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
  return (_: unknown, args: A, ctx: Context, info?: GraphQLResolveInfo) => run(() => fn(args, requireAuth(ctx)), operationOf(info));
}

export function toConnection<T>(page: { nodes: T[]; hasNextPage: boolean; endCursor: string | null }) {
  return { nodes: page.nodes, pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor } };
}
