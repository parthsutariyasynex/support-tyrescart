// The sign-in token is kept in localStorage (the API is called with it as a Bearer header) AND mirrored in this cookie,
// so the Next.js server (proxy.ts) can check the sign-in before rendering a page: private pages never load signed out,
// and /login skips straight to the app when already signed in. Same JWT, same 7-day life as the API gives it.
export const SESSION_COOKIE = 'session_token';
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export function writeSessionCookie(token: string | null) {
  if (typeof document === 'undefined') return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = token
    ? `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax${secure}`
    : `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

export function hasSessionCookie() {
  return typeof document !== 'undefined' && document.cookie.split('; ').some((c) => c.startsWith(`${SESSION_COOKIE}=`) && c.length > SESSION_COOKIE.length + 1);
}
