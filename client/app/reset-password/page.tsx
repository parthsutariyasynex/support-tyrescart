'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { resetPassword } from '@/lib/auth';
import { AuthShell, FormMessage, buttonClass, inputClass } from '../AuthShell';

// Opened from the emailed link: /reset-password?token=...
export default function ResetPasswordPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null | undefined>(undefined); // undefined = not read yet
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get('token'));
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!token) return;
    const form = new FormData(e.currentTarget);
    const password = String(form.get('password'));
    if (password !== String(form.get('confirm'))) return setError("The passwords don't match");
    setLoading(true);
    setError('');
    try {
      await resetPassword(token, password);
      router.replace('/login?reset=1');
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }

  return (
    <AuthShell
      title="Set a new password"
      subtitle="Choose a new password for your account. You'll be signed out on other devices."
      footerText="Remembered it?"
      footerLinkText="Sign in →"
      footerLinkHref="/login"
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {/* Disabled (not replaced) when the link has no code, so nothing moves after the page loads */}
        <fieldset disabled={token === null} className="space-y-4 disabled:opacity-60">
          <div>
            <label className="block text-[13px] font-medium text-body">
              New password <span className="text-danger-icon">*</span>
            </label>
            <div className="relative mt-1.5">
              <input
                name="password"
                type={showPassword ? 'text' : 'password'}
                required
                minLength={8}
                maxLength={72}
                autoFocus
                autoComplete="new-password"
                placeholder="At least 8 characters"
                className={`${inputClass} pr-16`}
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-0 pr-3 text-xs text-faint hover:text-body-soft"
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-[13px] font-medium text-body">
              Confirm new password <span className="text-danger-icon">*</span>
            </label>
            <input
              name="confirm"
              type={showPassword ? 'text' : 'password'}
              required
              autoComplete="new-password"
              placeholder="Type it again"
              className={`${inputClass} mt-1.5`}
            />
          </div>
        </fieldset>

        <FormMessage>
          {token === null ? (
            <>
              This link is missing its code. Open the link from your email again, or{' '}
              <Link href="/forgot-password" className="underline">
                request a new one
              </Link>
              .
            </>
          ) : (
            error && (
              <>
                {error}{' '}
                {/expired|invalid|used/i.test(error) && (
                  <Link href="/forgot-password" className="underline">
                    Request a new link
                  </Link>
                )}
              </>
            )
          )}
        </FormMessage>

        <button disabled={loading || !token} className={buttonClass}>
          {/* Both labels share one grid cell, so swapping them doesn't move the text */}
          <span className="grid text-center">
            <span className={`[grid-area:1/1] ${loading ? 'invisible' : ''}`}>Update password</span>
            <span className={`[grid-area:1/1] ${loading ? '' : 'invisible'}`}>Saving…</span>
          </span>
        </button>
      </form>
    </AuthShell>
  );
}
