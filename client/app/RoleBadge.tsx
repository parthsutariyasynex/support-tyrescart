import { roleStyle } from '@/lib/roles';

// Coloured role pill next to a person's name: Admin (purple), Supervisor (blue), Agent (green).
// The workspace owner shows as Admin, with "Owner" in the tooltip.
export function RoleBadge({ role, className = '' }: { role: string | null | undefined; className?: string }) {
  if (!role) return null;
  const { label, color } = roleStyle(role);
  return (
    <span
      title={role === 'owner' ? 'Admin (workspace owner)' : label}
      className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-px text-[9px] font-semibold uppercase leading-4 tracking-wide ${className}`}
      style={{ backgroundColor: color, color: '#ffffff' }}
    >
      {label}
    </span>
  );
}
