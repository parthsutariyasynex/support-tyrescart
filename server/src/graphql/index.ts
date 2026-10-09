import type { Request, Response } from 'express';
import { createSchema, createYoga } from 'graphql-yoga';
import { verifyToken, type AuthPayload } from '../auth.js';
import { env } from '../env.js';
import * as auth from './auth.js';
import * as inbox from './inbox.js';
import * as settings from './settings.js';
import * as shared from './shared.js';
import type { Context } from './shared.js';

type ServerContext = { req: Request; res: Response };

const modules = [shared, auth, settings, inbox];

export const yoga = createYoga<ServerContext, Context>({
  schema: createSchema<ServerContext & Context>({
    typeDefs: modules.map((m) => m.typeDefs),
    resolvers: modules.map((m) => m.resolvers),
  }),
  graphiql: !env.isProd,
  landingPage: false,
  cors: { origin: env.webOrigin },
  context: ({ req }): Context => {
    const header = req.headers.authorization ?? '';
    let auth: AuthPayload | null = null;
    if (header.startsWith('Bearer ')) {
      try {
        auth = verifyToken(header.slice(7));
      } catch {
        // invalid or expired token: treat as logged out
      }
    }
    return { auth, ip: req.ip ?? req.socket.remoteAddress ?? 'unknown' };
  },
});
