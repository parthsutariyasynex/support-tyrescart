'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { requestPasswordReset } from '@/lib/auth';
import { AuthShell, FormMessage, buttonClass, inputClass } from '../AuthShell';

export default function ForgotPasswordPage() {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  // The confirmation replaces the form; keep the same height so the page doesn't move
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyHeight, setBodyHeight] = useState<number | undefined>(undefined);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get('email')).trim();
    setLoading(true);
    setError('');
    try {
      await requestPasswordReset(email);
      setBodyHeight(bodyRef.current?.offsetHeight);
      setSentTo(email);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell
      title="Forgot password?"
      subtitle="Enter your account email and we'll send you a link to set a new password."
      footerText="Remembered it?"
      footerLinkText="Sign in →"
      footerLinkHref="/login"
    >
      <div ref={bodyRef} style={{ minHeight: bodyHeight }}>
        {sentTo ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-primary-soft-border bg-primary-subtle px-3.5 py-3 text-xs leading-relaxed text-body">
              If an account exists for <span className="font-semibold text-ink">{sentTo}</span>, we&apos;ve emailed a
              link to reset your password. It works once and expires in 30 minutes. Check your spam folder if you
              don&apos;t see it.
            </div>
            <button
              type="button"
              onClick={() => setSentTo(null)}
              className="text-xs font-medium text-primary hover:underline"
            >
              Send to a different email
            </button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="block text-[13px] font-medium text-body">
                Email <span className="text-danger-icon">*</span>
              </label>
              <input
                name="email"
                type="email"
                required
                autoFocus
                autoComplete="email"
                placeholder="you@company.com"
                className={`${inputClass} mt-1.5`}
              />
            </div>

            <FormMessage>{error}</FormMessage>

            <button disabled={loading} className={buttonClass}>
              <span>{loading ? 'Sending…' : 'Send reset link'}</span>
            </button>
            <p className="text-center text-xs text-faint">
              <Link href="/login" className="hover:text-body">
                Back to sign in
              </Link>
            </p>
          </form>
        )}
      </div>
    </AuthShell>
  );
}
