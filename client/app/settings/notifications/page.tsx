'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

// Notifications moved to Settings → General → System preference; the old address still works
export default function NotificationsSettingsPage() {
  const router = useRouter();
  useEffect(() => router.replace('/settings?tab=system'), [router]);
  return null;
}
