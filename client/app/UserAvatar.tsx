'use client';

import { useEffect, useState } from 'react';
import { myAvatarUrl } from '@/lib/avatar';
import type { Me } from './AppShell';

// You: your profile picture, or your initial when you have none (or it can't be loaded)
export function UserAvatar({ me, className, children }: { me: Me; className: string; children?: React.ReactNode }) {
  const version = me.user.avatarUpdatedAt ?? null;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    myAvatarUrl(version).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [version]);
  const initial = (me.user.name || me.user.email || 'U').charAt(0).toUpperCase();
  return (
    <span className={`relative flex shrink-0 items-center justify-center rounded-full bg-secondary font-bold text-on-primary ${className}`}>
      {url ? <img src={url} alt="" className="h-full w-full rounded-full object-cover" /> : initial}
      {children}
    </span>
  );
}
