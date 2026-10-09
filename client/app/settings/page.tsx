'use client';

import { useState } from 'react';
import { API_URL } from '@/lib/api';
import { connectWhatsApp } from '@/lib/settings';
import { AppShell, type Me } from '../AppShell';
import { buttonClass, inputClass } from '../AuthShell';

export default function SettingsPage() {
  return <AppShell>{(me) => <Settings me={me} />}</AppShell>;
}

function Settings({ me }: { me: Me }) {
  const [connected, setConnected] = useState(me.workspace.whatsapp?.displayPhone ?? null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess(false);
    try {
      const form = new FormData(e.currentTarget);
      const account = await connectWhatsApp({
        wabaId: String(form.get('wabaId')),
        phoneNumberId: String(form.get('phoneNumberId')),
        accessToken: String(form.get('accessToken')),
      });
      setConnected(account.displayPhone);
      setSuccess(true);
    } catch (err) {
      setError((err as Error).message);
    }
    setLoading(false);
  }

  return (
    <div className="h-full overflow-y-auto bg-page p-6 lg:p-10">
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">Workspace Settings</h1>
          <p className="text-xs text-muted mt-0.5">Manage your WhatsApp Business connection and Webhook configuration.</p>
        </div>

        {/* WhatsApp Connection Card */}
        <section className="rounded-2xl border border-line bg-surface p-6 shadow-xs">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-ink flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary-soft text-primary text-xs">💬</span>
              WhatsApp Cloud API Setup
            </h2>
            {connected ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2.5 py-0.5 text-xs font-semibold text-primary">
                ● Connected: {connected}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft border border-warning-border px-2.5 py-0.5 text-xs font-medium text-warning">
                Not connected
              </span>
            )}
          </div>

          <p className="mt-3 text-xs leading-relaxed text-muted">
            From Meta Developer Dashboard (<a href="https://developers.facebook.com" target="_blank" rel="noreferrer" className="text-primary underline font-medium">developers.facebook.com</a>), open your WhatsApp Business app and copy the credentials:
          </p>

          <form onSubmit={onSubmit} className="mt-4 space-y-3.5">
            <div>
              <label className="block text-xs font-medium text-body">WhatsApp Business Account ID (WABA ID)</label>
              <input name="wabaId" required placeholder="e.g. 845270958305032" className={`${inputClass} mt-1`} />
            </div>

            <div>
              <label className="block text-xs font-medium text-body">Phone Number ID</label>
              <input name="phoneNumberId" required placeholder="e.g. 1150993524765951" className={`${inputClass} mt-1`} />
            </div>

            <div>
              <label className="block text-xs font-medium text-body">Access Token (Permanent System User Token)</label>
              <input name="accessToken" required type="password" placeholder="EAAzGsMVZC..." className={`${inputClass} mt-1`} />
            </div>

            {error && <div className="rounded-xl bg-danger-soft p-3 text-xs font-medium text-danger">{error}</div>}
            {success && <div className="rounded-xl bg-success-soft p-3 text-xs font-medium text-success">WhatsApp connected successfully!</div>}

            <button disabled={loading} className={`${buttonClass} mt-2`}>
              {loading ? 'Verifying with Meta…' : connected ? 'Update WhatsApp Connection' : 'Connect WhatsApp'}
            </button>
          </form>
        </section>

        {/* Webhook Configuration Card */}
        <section className="rounded-2xl border border-line bg-surface p-6 shadow-xs text-xs">
          <h2 className="text-sm font-bold text-ink flex items-center gap-2">
            <span>🔗</span> Meta Webhook Configuration
          </h2>
          <p className="mt-2 text-muted leading-relaxed">
            In your Meta App Dashboard under <strong>WhatsApp &gt; Configuration</strong>, add the webhook so incoming customer messages appear in your Inbox:
          </p>

          <dl className="mt-4 space-y-3 rounded-xl bg-surface-muted p-4 border border-line/80">
            <div>
              <dt className="text-faint font-medium">Callback URL</dt>
              <dd className="font-mono text-ink-soft font-semibold mt-0.5 select-all">{API_URL}/webhook</dd>
            </div>
            <div>
              <dt className="text-faint font-medium">Verify Token</dt>
              <dd className="font-mono text-ink-soft font-semibold mt-0.5 select-all">META_VERIFY_TOKEN from server/.env</dd>
            </div>
          </dl>

          <p className="mt-3 text-muted">
            Subscribe to the <span className="rounded bg-surface-strong px-1.5 py-0.5 font-mono text-body">messages</span> webhook event. (Meta requires public HTTPS, so use ngrok during local development).
          </p>
        </section>
      </div>
    </div>
  );
}

