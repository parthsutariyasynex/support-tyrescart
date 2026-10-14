'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { isAdminRole } from '@/lib/roles';
import { AppShell, type Me } from '../AppShell';
import { TeamSection } from '../settings/team';

// Teams tab: owners and admins only. Everyone in the workspace with name, email, role and status, kept live.
// Supervisors and agents are sent back to the Inbox (and the server refuses the members query to them anyway).
export default function TeamsPage() {
  return <AppShell>{(me) => <Teams me={me} />}</AppShell>;
}

function Teams({ me }: { me: Me }) {
  const router = useRouter();
  const admin = isAdminRole(me.role);
  useEffect(() => {
    if (!admin) router.replace('/inbox');
  }, [admin, router]);
  if (!admin) return null;
  return (
    <div className="h-full overflow-y-auto bg-page/40 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto w-full max-w-6xl">
        <TeamSection meId={me.user.id} role={me.role} />
      </div>
    </div>
  );
}
