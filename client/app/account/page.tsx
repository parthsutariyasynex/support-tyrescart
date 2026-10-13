'use client';

import { useState } from 'react';
import { setToken } from '@/lib/api';
import { changeMyPassword } from '@/lib/auth';
import { passwordsProblem } from '@/lib/password';
import { AppShell, type Me } from '../AppShell';
import { FormMessage, buttonClass, inputClass } from '../AuthShell';
import { RoleBadge } from '../RoleBadge';

// My account: who you are signed in as, and changing your own password (e.g. away from the default an admin
// gave you). Everyone has this page; the server checks the current password and only stores a hash.
export default function AccountPage() {
  return <AppShell>{(me) => <Account me={me} />}</AppShell>;
}

function Account({ me }: { me: Me }) {
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const current = String(form.get('current') ?? '');
    const next = String(form.get('password') ?? '');
    const problem = passwordsProblem(next, String(form.get('confirm') ?? ''));
    setError('');
    setDone(false);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      const { token } = await changeMyPassword(current, next);
      setToken(token); // other sessions are signed out; this one carries on with the fresh token
      setDone(true);
      e.currentTarget.reset();
      setTimeout(() => window.location.reload(), 1200); // live connections reconnect with the new token
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const type = show ? 'text' : 'password';
  return (
    <div className="mx-auto w-full max-w-lg space-y-6 p-4 sm:p-6">
      <section className="rounded-2xl border border-line bg-surface p-6 shadow-xs">
        <h2 className="text-sm font-bold text-ink">My account</h2>
        <p className="mt-2 flex items-center gap-1.5 text-xs text-body">
          <span className="font-semibold">{me.user.name}</span>
          <RoleBadge role={me.role} />
        </p>
        <p className="text-xs text-muted">{me.user.email}</p>
        <p className="mt-1 font-mono text-[10px] text-faint" title="User ID (unique, never changes)">
          ID {me.user.id}
        </p>
      </section>

      <section className="rounded-2xl border border-line bg-surface p-6 shadow-xs">
        <h2 className="text-sm font-bold text-ink">Change password</h2>
        <p className="mt-1 text-xs text-muted">
          8 or more characters with at least one letter and one number. Your other devices are signed out.
        </p>
        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <input name="current" type={type} required autoComplete="current-password" placeholder="Current password" aria-label="Current password" className={inputClass} />
          <input name="password" type={type} required autoComplete="new-password" maxLength={72} placeholder="New password" aria-label="New password" className={inputClass} />
          <input name="confirm" type={type} required autoComplete="new-password" maxLength={72} placeholder="Confirm new password" aria-label="Confirm new password" className={inputClass} />
          <label className="flex items-center gap-2 text-[11px] text-muted">
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
            Show passwords
          </label>
          <FormMessage>{error}</FormMessage>
          {done && <FormMessage tone="success">Password changed. Reloading…</FormMessage>}
          <button disabled={busy} className={buttonClass}>
            {busy ? 'Saving…' : 'Change password'}
          </button>
        </form>
      </section>
    </div>
  );
}
