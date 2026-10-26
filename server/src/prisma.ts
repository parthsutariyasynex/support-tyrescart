import { PrismaClient } from '@prisma/client';

// Database errors are reported (services/logging.ts plugs in the reporter), then thrown on as before: nothing the
// database refuses is swallowed here. The log table's own writes are left out, so a database outage can't make
// logging report itself in a loop.
export type DbError = { model: string | null; operation: string; durationMs: number; error: unknown };
let reportDbError: ((e: DbError) => void) | null = null;
export function setDbErrorReporter(fn: ((e: DbError) => void) | null) {
  reportDbError = fn;
}

const base = new PrismaClient({ log: [{ emit: 'event', level: 'error' }, { emit: 'event', level: 'warn' }] });
// The engine's own errors and warnings (connection lost, pool timeouts…). Prisma raises this event for every failed
// query too (target "model.operation"); those are reported by the query hook below, with more detail, so skipped here.
const isQueryTarget = (target: string) => /^[a-z][A-Za-z0-9]*\.[a-zA-Z]+$/.test(target);
base.$on('error', (e) => {
  if (!isQueryTarget(e.target)) reportDbError?.({ model: null, operation: 'engine', durationMs: 0, error: Object.assign(new Error(e.message), { code: 'ENGINE_ERROR', target: e.target }) });
});
base.$on('warn', (e) => {
  if (!isQueryTarget(e.target)) reportDbError?.({ model: null, operation: 'engine:warn', durationMs: 0, error: Object.assign(new Error(e.message), { code: 'ENGINE_WARNING', target: e.target }) });
});

export const prisma = base.$extends({
  query: {
    async $allOperations({ model, operation, args, query }) {
      const started = Date.now();
      try {
        return await query(args);
      } catch (error) {
        if (model !== 'LogEntry') {
          try {
            reportDbError?.({ model: model ?? null, operation, durationMs: Date.now() - started, error });
          } catch {
            // reporting must never change what the caller gets
          }
        }
        throw error;
      }
    },
  },
});
