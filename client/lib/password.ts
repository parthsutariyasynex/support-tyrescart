// Pre-filled in the "Add a person" form so every new user starts with the same known password (they change it
// themselves under My account). Override with NEXT_PUBLIC_DEFAULT_USER_PASSWORD; it must satisfy the rule below.
export const DEFAULT_NEW_USER_PASSWORD = process.env.NEXT_PUBLIC_DEFAULT_USER_PASSWORD || 'Tyres@123';

// Same rule as the server (services/auth.ts): 8-72 characters with at least one letter and one number.
// Checked in the form first so the admin sees the problem before anything is sent; the server checks again.
export function passwordProblem(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (password.length > 72) return 'Password is too long';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Password must include at least one letter and one number';
  return null;
}

// A random password that meets the rule (12 characters, letters and digits, no look-alikes). Shown to the admin
// so they can pass it on; never stored or logged by the client.
const SUGGEST_CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function suggestPassword(random: (n: number) => number = defaultRandom): string {
  for (;;) {
    let out = '';
    for (let i = 0; i < 12; i++) out += SUGGEST_CHARS[random(SUGGEST_CHARS.length)];
    if (passwordProblem(out) === null) return out; // the rare all-letters or all-digits draw is re-rolled
  }
}
function defaultRandom(n: number) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % n;
}

// Both fields of a create/edit form: the strength rule, then the two must match
export function passwordsProblem(password: string, confirm: string): string | null {
  return passwordProblem(password) ?? (password === confirm ? null : 'Passwords do not match');
}
