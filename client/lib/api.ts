export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// A GraphQL error with the server's error code (e.g. ACCOUNT_EXISTS), so forms can offer the right next step
export class GqlError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
  }
}
export const errorCode = (err: unknown) => (err instanceof GqlError ? err.code : undefined);

// The request never reached the server (offline, DNS failure, or the backend is down/restarting) — as opposed to
// a response the server actually sent back (an auth error, a validation error, a 500). Callers use this to tell
// "can't reach the API right now, offer retry" apart from "the API answered and said no".
export class NetworkError extends Error {
  constructor(message = "Couldn't reach the server. Check your connection and try again.") {
    super(message);
  }
}
export const isNetworkError = (err: unknown) => err instanceof NetworkError;
// No answer within the time limit: the request may still have been carried out (e.g. a reply sent), so callers say
// it's unknown rather than "not sent"
export class RequestTimeoutError extends NetworkError {
  constructor(public timeoutMs: number) {
    super(`No answer from the server within ${Math.round(timeoutMs / 1000)} s. It may still have gone through: check before trying again.`);
  }
}

// An id for one request, sent as X-Request-Id: the server's logs for it carry the same id as the browser's own reports
export function newRequestId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

// fetch() only rejects for network-level failures (refused/reset connection, timeout, offline, CORS) — never for
// a response with a non-2xx status, which resolves normally. So any rejection here is a NetworkError.
async function fetchOrThrowNetworkError(input: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
  try {
    return await fetch(input, timeoutMs ? { ...init, signal: AbortSignal.timeout(timeoutMs) } : init);
  } catch (err) {
    if (timeoutMs && (err as Error)?.name === 'TimeoutError') throw new RequestTimeoutError(timeoutMs);
    throw new NetworkError();
  }
}

// Every response this API actually sends — success or error, REST or GraphQL — is JSON. A non-JSON body on a
// failed request means the request never made it to our app code: nginx's own 502/504 HTML page when the
// backend is down, or (since nginx proxies everything to the Next.js server, which then proxies /graphql,
// /auth etc. to the backend internally) Next's plain-text 500 when ITS proxy to the backend fails mid-restart.
// Either way, treat it as "can't reach the server right now", not as an application error.
async function parseJsonOrThrowNetworkError(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    if (res.ok) return {};
    throw new NetworkError('The server is temporarily unavailable (it may be restarting). Please try again in a moment.');
  }
}

export function getToken() {
  return typeof window === 'undefined' ? null : localStorage.getItem('token');
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem('token', token);
  else localStorage.removeItem('token');
}

export async function api<T = any>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken();
  const res = await fetchOrThrowNetworkError(`${API_URL}${path}`, {
    method: options.method ?? (options.body ? 'POST' : 'GET'),
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/')) {
    setToken(null);
    window.location.href = '/login';
  }
  const data = await parseJsonOrThrowNetworkError(res);
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

// requestId: sent as X-Request-Id (the server logs the request under it); timeoutMs: give up waiting after that long
// (RequestTimeoutError); reported: the caller reports a failure itself (otherwise a failed mutation is reported to
// the logs here as client.api_error)
export type GqlOptions = { requestId?: string; timeoutMs?: number; reported?: boolean };

// The operation's name for the reports: "sendTextMessage" from "mutation SendText($input…) { sendTextMessage(…"
export const operationName = (query: string) => /^\s*(query|mutation|subscription)\b[^{]*\{\s*(\w+)/.exec(query)?.[2] ?? null;

// GraphQL client for /graphql. Throws the first error message, like api().
export async function gql<T = any>(query: string, variables?: Record<string, unknown>, options: GqlOptions = {}): Promise<T> {
  const started = Date.now();
  const mutation = /^\s*mutation\b/.test(query);
  const requestId = options.requestId ?? (mutation ? newRequestId() : undefined);
  try {
    const token = getToken();
    const res = await fetchOrThrowNetworkError(
      `${API_URL}/graphql`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(requestId ? { 'X-Request-Id': requestId } : {}),
        },
        body: JSON.stringify({ query, variables }),
      },
      options.timeoutMs,
    );
    const json = await parseJsonOrThrowNetworkError(res);
    const error = json.errors?.[0];
    if (error) {
      if (error.extensions?.code === 'UNAUTHENTICATED' && typeof window !== 'undefined') {
        setToken(null);
        window.location.href = '/login';
      }
      throw new GqlError(error.message, error.extensions?.code);
    }
    if (!res.ok || !json.data) throw new Error(`Request failed (${res.status})`);
    return json.data;
  } catch (err) {
    // A failed change is reported to the logs (sign-in problems aren't: the app goes to the sign-in page)
    if (mutation && !options.reported && errorCode(err) !== 'UNAUTHENTICATED')
      void import('./clientLog').then(({ reportClient }) =>
        reportClient({ event: 'api_error', requestId, operation: operationName(query), durationMs: Date.now() - started, error: describeError(err) }),
      );
    throw err;
  }
}

// An error for the reports: what it says, its code, and what kind of failure it was
export function describeError(err: unknown): { message: string; code?: string; kind: 'network' | 'timeout' | 'api' | 'ui' } {
  const message = (err as Error)?.message ?? String(err);
  if (err instanceof RequestTimeoutError) return { message, kind: 'timeout' };
  if (err instanceof NetworkError) return { message, kind: 'network' };
  if (err instanceof GqlError) return { message, code: err.code, kind: 'api' };
  return { message, kind: err instanceof Error && /^Request failed \(\d+\)$/.test(message) ? 'api' : 'ui' };
}
