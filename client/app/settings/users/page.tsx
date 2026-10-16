'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { isAdminRole } from '@/lib/roles';
import { AppShell, type Me } from '../../AppShell';
import { SettingsShell } from '../SettingsShell';
import { TeamSection } from '../team';

// Settings → Company settings → User management: the same team page as /teams, inside Settings (owners/admins)
export default function SettingsUsersPage() {
  return (
    <AppShell>
      {(me) => (
        <SettingsShell me={me} section="Company settings" title="User management">
          <Users me={me} />
        </SettingsShell>
      )}
    </AppShell>
  );
}

function Users({ me }: { me: Me }) {
  const router = useRouter();
  const admin = isAdminRole(me.role);
  useEffect(() => {
    if (!admin) router.replace('/settings');
  }, [admin, router]);
  if (!admin) return null;
  return (
    <div className="max-w-6xl">
      <TeamSection meId={me.user.id} role={me.role} />
    </div>
  );
}
