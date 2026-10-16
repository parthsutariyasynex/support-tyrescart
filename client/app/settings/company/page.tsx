'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { isAdminRole } from '@/lib/roles';
import { AppShell, type Me } from '../../AppShell';
import { SettingsShell } from '../SettingsShell';

// Settings → Company details (owners and admins): this workspace and its WhatsApp connection, read-only
export default function CompanyPage() {
  return (
    <AppShell>
      {(me) => (
        <SettingsShell me={me} section="Company settings" title="Company details">
          <Company me={me} />
        </SettingsShell>
      )}
    </AppShell>
  );
}

function Company({ me }: { me: Me }) {
  const router = useRouter();
  const admin = isAdminRole(me.role);
  useEffect(() => {
    if (!admin) router.replace('/settings');
  }, [admin, router]);
  if (!admin) return null;
  const wa = me.workspace.whatsapp;
  const row = (label: string, value: React.ReactNode, mono = false) => (
    <div className="grid grid-cols-[180px_1fr] gap-4 px-5 py-3.5">
      <dt className="text-[12px] font-semibold text-muted">{label}</dt>
      <dd className={`break-all text-[13px] text-ink ${mono ? 'font-mono text-[12px]' : ''}`}>{value}</dd>
    </div>
  );
  return (
    <div className="max-w-3xl space-y-6">
      <section>
        <h3 className="mb-2 text-sm font-bold text-ink">Workspace</h3>
        <dl className="divide-y divide-line-soft rounded-xl border border-line bg-surface">
          {row('Name', me.workspace.name)}
          {row('Workspace ID', me.workspace.id, true)}
        </dl>
      </section>
      <section>
        <h3 className="mb-2 text-sm font-bold text-ink">WhatsApp</h3>
        <dl className="divide-y divide-line-soft rounded-xl border border-line bg-surface">
          {row(
            'Status',
            wa?.displayPhone ? (
              <span className="inline-flex items-center gap-1.5 font-semibold text-primary">
                <span className="h-2 w-2 rounded-full bg-accent" /> Connected
              </span>
            ) : (
              <span className="font-semibold text-warning">Not connected</span>
            ),
          )}
          {row('Business number', wa?.displayPhone ?? '–')}
          {row('Phone number ID', wa?.phoneNumberId ?? '–', true)}
          {row('WhatsApp Business account ID', wa?.wabaId ?? '–', true)}
        </dl>
      </section>
    </div>
  );
}
