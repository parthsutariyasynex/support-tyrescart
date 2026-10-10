import type { Request, Response } from 'express';
import { createSchema, createYoga } from 'graphql-yoga';
import { verifyCurrentToken, type AuthPayload } from '../auth.js';
import { env } from '../env.js';
import * as activity from './activity.js';
import * as assign from './assign.js';
import * as auth from './auth.js';
import * as inbox from './inbox.js';
import * as labels from './labels.js';
import * as permissions from './permissions.js';
import * as settings from './settings.js';
import * as shared from './shared.js';
import type { Context } from './shared.js';

type ServerContext = { req: Request; res: Response };

const modules = [shared, auth, settings, inbox, labels, assign, permissions, activity];

export const yoga = createYoga<ServerContext, Context>({
  schema: createSchema<ServerContext & Context>({
    typeDefs: modules.map((m) => m.typeDefs),
    resolvers: modules.map((m) => m.resolvers),
  }),
  graphiql: !env.isProd,
  landingPage: false,
  cors: { origin: env.webOrigin },
  context: async ({ req }): Promise<Context> => {
    const header = req.headers.authorization ?? '';
    let auth: AuthPayload | null = null;
    if (header.startsWith('Bearer ')) {
      try {
        auth = await verifyCurrentToken(header.slice(7));
      } catch {
        // invalid, expired, or issued before a password reset: treat as logged out
      }
    }
    return { auth, ip: req.ip ?? req.socket.remoteAddress ?? 'unknown' };
  },
});
