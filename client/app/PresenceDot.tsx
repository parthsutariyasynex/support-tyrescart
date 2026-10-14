'use client';

import { PRESENCE_STYLES, type PresenceStatus } from '@/lib/presence';

// Small coloured dot: green Online, yellow Away, red Offline
export function PresenceDot({ status, size = 'h-2 w-2', withLabel = false }: { status: PresenceStatus; size?: string; withLabel?: boolean }) {
  const s = PRESENCE_STYLES[status];
  return (
    <span className="inline-flex shrink-0 items-center gap-1" title={s.label} data-presence={status}>
      <span className={`${size} rounded-full ring-2 ring-surface`} style={{ backgroundColor: s.color }} />
      {withLabel && <span className="text-[10px] text-muted">{s.label}</span>}
    </span>
  );
}
