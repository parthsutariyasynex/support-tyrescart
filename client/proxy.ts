import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from './lib/session';

// Sign-in check on the Next.js server, before a page renders. The token (lib/session.ts) is checked by the API's own
// GET /auth/me — the same check every API request gets (signature, expiry, password changed since, still an active
// member of the workspace) — so nothing about sign-in, roles or permissions changes here.
//   /          → /inbox when signed in, otherwise /login
//   /login     → / when already signed in (except a team join link, which needs the sign-in form's join step)
//   private    → /login when not signed in
// If the API can't be reached (a restart), private pages still load and the app shows its "retry" state, rather than
// signing everyone out.

// Same API address as next.config.ts's rewrites
const API = (process.env.API_PROXY_TARGET || 'http://127.0.0.1:5000').replace(/\/$/, '');

type Check = 'valid' | 'invalid' | 'unknown';
const CACHE_MS = 30_000; // page changes within this time reuse the answer (each one also sends an RSC request)
const CACHE_MAX = 5000;
const checked = new Map<string, { at: number; result: Check }>();

async function checkToken(token: string): Promise<Check> {
  const hit = checked.get(token);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  let result: Check;
  try {
    const res = await fetch(`${API}/auth/me`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(5000) });
    result = res.ok ? 'valid' : res.status === 401 ? 'invalid' : 'unknown';
  } catch {
    result = 'unknown';
  }
  if (result !== 'unknown') {
    if (checked.size >= CACHE_MAX) checked.delete(checked.keys().next().value!);
    checked.set(token, { at: Date.now(), result });
  }
  return result;
}

function redirect(request: NextRequest, path: string, clearCookie = false) {
  const res = NextResponse.redirect(new URL(path, request.url));
  if (clearCookie) res.cookies.delete(SESSION_COOKIE);
  return res;
}

export async function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE)?.value ?? '';
  const status: Check = token ? await checkToken(token) : 'invalid';

  if (pathname === '/login') {
    if (status === 'valid' && !searchParams.has('join')) return redirect(request, '/');
    return status === 'invalid' && token ? clearing(NextResponse.next()) : NextResponse.next();
  }
  if (pathname === '/') return status === 'invalid' ? redirect(request, '/login', !!token) : redirect(request, '/inbox');
  // Every other matched path is a private page
  if (status === 'invalid') return redirect(request, '/login', !!token);
  return NextResponse.next();
}

function clearing(res: NextResponse) {
  res.cookies.delete(SESSION_COOKIE);
  return res;
}

// Pages only: the API paths Next forwards to the backend (/graphql, /auth/*, /inbox/conversations/*, /reports/*.csv,
// /live/*, /webhook, …) and the public pages (/register, /forgot-password, /reset-password) are not matched.
export const config = {
  matcher: [
    '/',
    '/login',
    '/inbox',
    '/my-chats',
    '/leads',
    '/mentions',
    '/collaborations',
    '/contacts/:id',
    '/reports',
    '/teams',
    '/account',
    '/settings',
    '/settings/:path*',
  ],
};
