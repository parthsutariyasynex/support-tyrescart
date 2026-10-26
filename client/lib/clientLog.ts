import { API_URL, getToken } from './api';

// The web app's reports for the server's logs (POST /client-log): each step of sending a reply, failed API calls,
// and errors nobody caught. Never in the way: reporting can't throw or slow anything down. Reports that can't be
// delivered (offline, the server restarting) wait in the tab (sessionStorage) and go with the next report or when
// the browser is back online, marked with how late they are; a few dozen at most, oldest dropped first.

export type ClientEvent = {
  event: 'send_started' | 'send_succeeded' | 'send_failed' | 'api_error' | 'error';
  requestId?: string;
  conversationId?: string;
  messageId?: string;
  replyToId?: string | null;
  status?: string;
  content?: string;
  operation?: string | null;
  durationMs?: number;
  error?: { message: string; code?: string; kind: string };
};

type Queued = ClientEvent & { at: string; page?: string; delayedMs?: number };
type Deps = {
  send: (events: Queued[]) => Promise<boolean>; // true: delivered
  load: () => Queued[];
  save: (events: Queued[]) => void;
  now: () => number;
  page: () => string | undefined;
};

export const MAX_QUEUED = 50;
const BATCH = 20; // the server takes at most 20 at a time

// The reporter, with its outside world passed in (tests give their own)
export function createClientLog(deps: Deps) {
  let flushing: Promise<void> | null = null;
  const flush = (): Promise<void> => {
    if (flushing) return flushing;
    flushing = (async () => {
      try {
        for (;;) {
          const queue = deps.load();
          if (!queue.length) return;
          const batch = queue.slice(0, BATCH).map((e) => ({ ...e, delayedMs: Math.max(0, deps.now() - Date.parse(e.at)) }));
          if (!(await deps.send(batch).catch(() => false))) return; // kept for next time
          deps.save(deps.load().slice(batch.length));
        }
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  };
  return {
    report(e: ClientEvent) {
      try {
        const queued: Queued = { ...e, at: new Date(deps.now()).toISOString(), page: deps.page() };
        deps.save([...deps.load(), queued].slice(-MAX_QUEUED));
        return flush();
      } catch {
        return Promise.resolve(); // reporting never breaks the app
      }
    },
    flush,
  };
}

const KEY = 'clientLogQueue';
const browser = typeof window !== 'undefined';
let memory: Queued[] = [];

const log = createClientLog({
  send: async (events) => {
    const token = getToken();
    if (!token) return true; // signed out: nothing can be reported, drop them
    const res = await fetch(`${API_URL}/client-log`, {
      method: 'POST',
      keepalive: true, // still delivered when the page is being closed
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ events }),
    });
    // 4xx: the server won't take these (bad or unauthorised), so retrying won't help; 5xx: keep them for later
    return res.ok || (res.status >= 400 && res.status < 500);
  },
  load: () => {
    if (!browser) return memory;
    try {
      const stored = JSON.parse(sessionStorage.getItem(KEY) ?? '[]');
      return Array.isArray(stored) ? stored : memory;
    } catch {
      return memory;
    }
  },
  save: (events) => {
    memory = events;
    if (!browser) return;
    try {
      sessionStorage.setItem(KEY, JSON.stringify(events));
    } catch {
      // storage full or blocked: the in-memory copy still works for this page
    }
  },
  now: () => Date.now(),
  page: () => (browser ? window.location.pathname : undefined),
});

export const reportClient = (e: ClientEvent) => log.report(e);

// Errors nobody caught in this page (at most a few per page load: a broken page mustn't flood the logs)
const MAX_ERRORS = 10;
let errors = 0;
const reportError = (message: string) => {
  if (errors++ >= MAX_ERRORS) return;
  void log.report({ event: 'error', error: { message: message.slice(0, 1000), kind: 'ui' } });
};

if (browser) {
  window.addEventListener('online', () => void log.flush());
  window.addEventListener('error', (e) => reportError(`${e.message || 'Script error'}${e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : ''}`));
  window.addEventListener('unhandledrejection', (e) => reportError(`Unhandled promise rejection: ${(e.reason as Error)?.message ?? String(e.reason)}`));
}
