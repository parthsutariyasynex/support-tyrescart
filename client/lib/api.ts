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

// fetch() only rejects for network-level failures (refused/reset connection, timeout, offline, CORS) — never for
// a response with a non-2xx status, which resolves normally. So any rejection here is a NetworkError.
async function fetchOrThrowNetworkError(input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
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

// GraphQL client for /graphql. Throws the first error message, like api().
export async function gql<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const token = getToken();
  const res = await fetchOrThrowNetworkError(`${API_URL}/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
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
}
