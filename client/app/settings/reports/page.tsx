'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { isAdminRole } from '@/lib/roles';
import { AppShell, type Me } from '../../AppShell';
import { AssignmentReport } from '../../reports/AssignmentReport';
import { SettingsShell } from '../SettingsShell';

// Settings → Company settings → Reports: the same assignment report as /reports, inside Settings (owners/admins)
export default function SettingsReportsPage() {
  return (
    <AppShell>
      {(me) => (
        <SettingsShell me={me} section="Company settings" title="Reports">
          <Reports me={me} />
        </SettingsShell>
      )}
    </AppShell>
  );
}

function Reports({ me }: { me: Me }) {
  const router = useRouter();
  const admin = isAdminRole(me.role);
  useEffect(() => {
    if (!admin) router.replace('/settings');
  }, [admin, router]);
  if (!admin) return null;
  return (
    <div className="max-w-6xl space-y-6">
      <AssignmentReport />
    </div>
  );
}
