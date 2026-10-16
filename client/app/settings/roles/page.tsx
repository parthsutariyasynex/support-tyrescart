'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { isAdminRole } from '@/lib/roles';
import { AppShell, type Me } from '../../AppShell';
import { SettingsShell } from '../SettingsShell';

// Settings → Roles and permissions (owners and admins): what each role can do. These are the rules the server
// enforces; roles are changed on User management (Teams).
export default function RolesPage() {
  return (
    <AppShell>
      {(me) => (
        <SettingsShell me={me} section="Company settings" title="Roles and permissions">
          <Roles me={me} />
        </SettingsShell>
      )}
    </AppShell>
  );
}

const ROLES = ['owner', 'admin', 'supervisor', 'agent'] as const;
// yes / no / text per role, in ROLES order
const RULES: { what: string; can: (boolean | string)[] }[] = [
  { what: 'Read and reply to chats', can: [true, true, true, 'Their own chats; New Leads after Assign to Me'] },
  { what: 'Reply to an unassigned chat', can: [true, true, true, false] },
  { what: 'Assign, reassign and unassign chats', can: [true, true, true, 'Assign to Me only'] },
  { what: 'Add and remove collaborators', can: [true, true, true, true] },
  { what: 'Close, reopen, snooze and pin chats', can: [true, true, true, true] },
  { what: 'Create labels and put them on chats', can: [true, true, true, true] },
  { what: 'Rename, recolour and delete labels', can: [true, true, true, 'If granted on User management'] },
  { what: 'Edit contact profiles, remarks and lists', can: [true, true, true, true] },
  { what: 'Edit or delete a remark', can: ['Any', 'Any', 'Their own', 'Their own'] },
  { what: 'Delete contact lists', can: [true, true, false, false] },
  { what: 'Notifications (bell)', can: ['Everything', 'Everything', 'Their chats', 'Their chats'] },
  { what: 'User management: add people, roles, deactivate', can: [true, true, false, false] },
  { what: 'Reports (assignment report and export)', can: [true, true, false, false] },
  { what: 'Company details and these settings', can: [true, true, false, false] },
];

function Roles({ me }: { me: Me }) {
  const router = useRouter();
  const admin = isAdminRole(me.role);
  useEffect(() => {
    if (!admin) router.replace('/settings');
  }, [admin, router]);
  if (!admin) return null;
  const cell = (v: boolean | string) =>
    v === true ? (
      <span className="font-bold text-primary" aria-label="Yes">✓</span>
    ) : v === false ? (
      <span className="text-faint" aria-label="No">—</span>
    ) : (
      <span className="text-[12px] text-body">{v}</span>
    );
  return (
    <div className="max-w-5xl">
      <p className="text-xs text-muted">Change someone's role on User management. The owner's account can only be changed by the owner.</p>
      <div className="mt-4 overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-line">
              <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wide text-muted">What</th>
              {ROLES.map((r) => (
                <th key={r} className="px-4 py-3 text-center text-[12px] font-semibold capitalize text-ink">
                  {r}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {RULES.map((rule) => (
              <tr key={rule.what}>
                <td className="px-4 py-3 text-ink">{rule.what}</td>
                {rule.can.map((v, i) => (
                  <td key={ROLES[i]} className="px-4 py-3 text-center">
                    {cell(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
