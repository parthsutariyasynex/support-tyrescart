'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

// "My account & password" moved into Settings → My profile (Password tab); old links still work
export default function AccountPage() {
  const router = useRouter();
  useEffect(() => router.replace('/settings?tab=password'), [router]);
  return null;
}
