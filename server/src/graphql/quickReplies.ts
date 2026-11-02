import { prisma } from '../prisma.js';
import { createQuickReply, deleteQuickReply, listQuickReplies, updateQuickReply } from '../services/quickReplies.js';
import { authed } from './shared.js';

export const typeDefs = /* GraphQL */ `
  "A canned reply offered when typing / in the message box (WhatsApp Business-style quick replies)"
  type QuickReply {
    id: ID!
    "Typed after /, e.g. tyrescart"
    shortcut: String!
    "The message text it inserts"
    description: String
    "e.g. car_tyres, car_services, car_insurance, battery, other"
    category: String
    sortOrder: Int!
    createdAt: DateTime
    "Who added it in this app (null for imported replies)"
    createdByName: String
    updatedAt: DateTime
    "Who last edited it in this app (null for imported replies)"
    updatedByName: String
  }

  input CreateQuickReplyInput {
    "1-50 letters, numbers, _ or - (a leading / is dropped)"
    shortcut: String!
    "1-4096 characters"
    description: String!
    "Up to 50 characters, stored lowercase with spaces as _"
    category: String
    "0-100000; omitted: last in the list"
    sortOrder: Int
  }

  input UpdateQuickReplyInput {
    shortcut: String
    description: String
    "Empty string clears it"
    category: String
    sortOrder: Int
  }

  extend type Query {
    "This workspace's enabled quick replies. search: case-insensitive partial match on shortcut, text or category (best shortcut matches first). first: 1-100 (default 50)"
    quickReplies(search: String, first: Int): [QuickReply!]!
  }

  # Owners, admins and supervisors only
  extend type Mutation {
    createQuickReply(input: CreateQuickReplyInput!): QuickReply!
    updateQuickReply(id: ID!, input: UpdateQuickReplyInput!): QuickReply!
    "Soft delete: it leaves the list and the / menu. Returns the deleted id."
    deleteQuickReply(id: ID!): ID!
  }
`;

type ReplyParent = { createdBy?: string | null; updatedBy?: string | null };

// User names, looked up only when createdByName/updatedByName are asked for (the "/" menu doesn't), once per
// user per request
const nameCache = new WeakMap<object, Map<string, Promise<string | null>>>();
function userName(ctx: object, id: string | null | undefined) {
  if (!id) return null;
  let cache = nameCache.get(ctx);
  if (!cache) nameCache.set(ctx, (cache = new Map()));
  let name = cache.get(id);
  if (!name) {
    name = prisma.user.findUnique({ where: { id }, select: { name: true } }).then((u) => u?.name ?? null);
    cache.set(id, name);
  }
  return name;
}

export const resolvers = {
  Query: {
    quickReplies: authed(({ search, first }: { search?: string | null; first?: number | null }, { workspaceId }) =>
      listQuickReplies(workspaceId, { search: search ?? undefined, first: first ?? undefined }),
    ),
  },
  Mutation: {
    createQuickReply: authed(({ input }: { input: Record<string, unknown> }, auth) =>
      createQuickReply(auth, Object.fromEntries(Object.entries(input).filter(([, v]) => v != null))),
    ),
    updateQuickReply: authed(({ id, input }: { id: string; input: Record<string, unknown> }, auth) =>
      // GraphQL sends explicit nulls for omitted fields; drop them so they stay unchanged ("" clears the category)
      updateQuickReply(auth, id, Object.fromEntries(Object.entries(input).filter(([, v]) => v != null))),
    ),
    deleteQuickReply: authed(({ id }: { id: string }, auth) => deleteQuickReply(auth, id)),
  },
  QuickReply: {
    createdByName: (r: ReplyParent, _args: unknown, ctx: object) => userName(ctx, r.createdBy),
    updatedByName: (r: ReplyParent, _args: unknown, ctx: object) => userName(ctx, r.updatedBy),
  },
};
