'use client';

import { APP_NAME } from '@/lib/brand';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { setToken } from '@/lib/api';
import { login } from '@/lib/auth';
import { joinWorkspace } from '@/lib/members';
import { lastWorkspace } from '@/lib/workspaces';
import { AuthShell, FormMessage, buttonClass, inputClass } from '../AuthShell';

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // Arrived here after setting a new password
  const [passwordReset, setPasswordReset] = useState(false);
  // Arrived from a team signup link with an existing account: join that workspace after signing in
  const [joinToken, setJoinToken] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setPasswordReset(params.get('reset') === '1');
    setJoinToken(params.get('join'));
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setLoading(true);
    setError('');
    try {
      const email = String(form.get('email'));
      const { token } = await login({ email, password: String(form.get('password')), workspaceId: lastWorkspace(email) });
      setToken(token);
      if (joinToken) {
        try {
          setToken((await joinWorkspace(joinToken)).token);
        } catch (err) {
          alert(`Signed in, but couldn't join the team: ${(err as Error).message}`);
        }
      }
      router.push('/inbox');
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle={`Sign in to your ${APP_NAME} workspace.`}
      footerText={joinToken ? "Don't have an account?" : undefined}
      footerLinkText={joinToken ? 'Create your account →' : undefined}
      footerLinkHref={joinToken ? `/register?join=${encodeURIComponent(joinToken)}` : undefined}
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {/* Email Field */}
        <div>
          <label className="block text-[13px] font-medium text-body">
            Email <span className="text-danger-icon">*</span>
          </label>
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@company.com"
            className={`${inputClass} mt-1.5`}
          />
        </div>

        {/* Password Field */}
        <div>
          <div className="flex items-center justify-between">
            <label className="block text-[13px] font-medium text-body">
              Password <span className="text-danger-icon">*</span>
            </label>
            <Link href="/forgot-password" className="text-xs font-normal text-faint transition hover:text-body">
              Forgot?
            </Link>
          </div>
          <div className="relative mt-1.5">
            <input
              name="password"
              type={showPassword ? 'text' : 'password'}
              required
              autoComplete="current-password"
              placeholder="Enter your password"
              className={`${inputClass} pr-10`}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute inset-y-0 right-0 flex items-center pr-3 text-faint hover:text-body-soft focus:outline-hidden"
              tabIndex={-1}
            >
              {showPassword ? (
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              ) : (
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Error / "password updated" notice, in a fixed slot so nothing shifts */}
        {error ? (
          <FormMessage>{error}</FormMessage>
        ) : (
          <FormMessage tone="success">{passwordReset && 'Password updated. Sign in with your new password.'}</FormMessage>
        )}

        {/* Submit Button */}
        <button disabled={loading} className={buttonClass}>
          <span>{loading ? 'Signing in…' : 'Sign in'}</span>
          {!loading && (
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14" />
              <path d="m12 5 7 7-7 7" />
            </svg>
          )}
        </button>
      </form>
    </AuthShell>
  );
}

