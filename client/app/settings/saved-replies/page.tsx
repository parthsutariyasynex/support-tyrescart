'use client';

import { useEffect, useState } from 'react';
import { type QuickReply, fetchQuickReplies } from '@/lib/quickReplies';
import { AppShell } from '../../AppShell';
import { inputClass } from '../../AuthShell';
import { SettingsShell } from '../SettingsShell';
import { TableSkeleton } from '../Skeleton';

// Settings → Saved replies: this workspace's quick replies (type / in a chat to use one). Searchable here.
export default function SavedRepliesPage() {
  return (
    <AppShell>
      {(me) => (
        <SettingsShell me={me} section="Inbox settings" title="Saved replies">
          <SavedReplies />
        </SettingsShell>
      )}
    </AppShell>
  );
}

function SavedReplies() {
  const [search, setSearch] = useState('');
  const [replies, setReplies] = useState<QuickReply[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      fetchQuickReplies(search.trim())
        .then(setReplies)
        .catch((e) => setError((e as Error).message));
    }, 250);
    return () => clearTimeout(t);
  }, [search]);
  return (
    <div className="max-w-4xl">
      <p className="text-xs text-muted">
        Type <span className="rounded bg-surface-strong px-1 font-mono">/</span> in a chat's message box to insert one of these.
      </p>
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by shortcut, text or category" aria-label="Search saved replies" className={`${inputClass} mt-4 max-w-md`} />
      {error && <p className="mt-3 text-xs text-danger">{error}</p>}
      {replies === null ? (
        <TableSkeleton rows={4} />
      ) : replies.length === 0 ? (
        <p className="mt-6 text-sm text-muted">{search.trim() ? `No saved reply matches “${search.trim()}”.` : 'No saved replies yet.'}</p>
      ) : (
        <ul className="mt-4 divide-y divide-line-soft rounded-xl border border-line bg-surface">
          {replies.map((r) => (
            <li key={r.id} className="px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[13px] font-semibold text-primary">/{r.shortcut}</span>
                {r.category && <span className="rounded-full bg-surface-strong px-2 py-0.5 text-[10px] font-semibold text-body-soft">{r.category}</span>}
              </div>
              {r.description && <p className="mt-1 whitespace-pre-wrap text-[13px] text-body">{r.description}</p>}
            </li>
          ))}
        </ul>
      )}
      {replies && replies.length >= 100 && <p className="mt-2 text-[11px] text-faint">Showing the first 100. Search to find others.</p>}
    </div>
  );
}
