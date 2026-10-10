export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

export function getToken() {
  return typeof window === 'undefined' ? null : localStorage.getItem('token');
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem('token', token);
  else localStorage.removeItem('token');
}

export async function api<T = any>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

// GraphQL client for /graphql. Throws the first error message, like api().
export async function gql<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  const error = json.errors?.[0];
  if (error) {
    if (error.extensions?.code === 'UNAUTHENTICATED' && typeof window !== 'undefined') {
      setToken(null);
      window.location.href = '/login';
    }
    throw new Error(error.message);
  }
  if (!res.ok || !json.data) throw new Error(`Request failed (${res.status})`);
  return json.data;
}
