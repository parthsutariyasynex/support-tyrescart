'use client';

import { useEffect, useRef, useState } from 'react';
import { type WorkspaceMember, fetchWorkspaceMembers } from '@/lib/assignees';
import { addCollaborators, addableMembers, fetchCollaborators, removeCollaborator } from '@/lib/collaborators';
import { roleStyle } from '@/lib/roles';
import { collaboratorRemovedByYouText, showToast } from '@/lib/toasts';
import { AssigneeAvatar } from './assign';

// Their profile picture, or their initial on their role colour (id = the person's user id)
const Avatar = ({ m }: { m: Pick<WorkspaceMember, 'id' | 'name' | 'role'> }) => (
  <AssigneeAvatar assignee={{ name: m.name, color: roleStyle(m.role).color }} userId={m.id} size="h-7 w-7 text-[11px]" />
);

// Chat header "Collaborators" (person +): who is helping on this chat, and adding teammates to it
export function CollaboratorsButton({ conversationId, canEdit, meId, contactName = '' }: { conversationId: string; canEdit: boolean; meId: string | null; contactName?: string }) {
  const [open, setOpen] = useState(false);
  const [collaborators, setCollaborators] = useState<WorkspaceMember[] | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [showList, setShowList] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOpen(false);
    setCollaborators(null);
  }, [conversationId]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setPicked([]);
    setError('');
    fetchCollaborators(conversationId).then(setCollaborators).catch((e) => setError((e as Error).message));
    fetchWorkspaceMembers().then(setMembers).catch(() => {});
    const onPointer = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, conversationId]);

  const candidates = addableMembers(members, collaborators ?? [], query);

  async function run(fn: () => Promise<WorkspaceMember[]>) {
    setBusy(true);
    setError('');
    try {
      setCollaborators(await fn());
      setPicked([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const section = 'flex w-full items-center gap-1.5 px-1 py-1 text-[10px] font-bold uppercase tracking-wider text-faint';
  const caret = (on: boolean) => (
    <svg className={`h-3 w-3 transition ${on ? '' : '-rotate-90'}`} viewBox="0 0 24 24" fill="currentColor">
      <path d="M7 10l5 5 5-5z" />
    </svg>
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title="Collaborators"
        aria-label="Collaborators"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`relative flex h-7 w-7 items-center justify-center rounded-full border transition ${open ? 'border-primary text-primary' : 'border-line text-body-soft hover:bg-surface-strong hover:text-body'}`}
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M19 8v6M22 11h-6" />
        </svg>
        {!!collaborators?.length && (
          <span className="absolute -right-1 -top-1 rounded-full bg-primary px-1 text-[9px] font-bold text-on-primary">{collaborators.length}</span>
        )}
      </button>

      {open && (
        <div role="dialog" aria-label="Collaborators" className="absolute right-0 top-9 z-50 flex max-h-[70vh] w-72 flex-col overflow-hidden rounded-2xl border border-line bg-surface text-xs shadow-xl">
          <div className="border-b border-line-soft p-2.5">
            <button type="button" onClick={() => setShowList((v) => !v)} className={section}>
              {caret(showList)} Collaborators{collaborators?.length ? ` (${collaborators.length})` : ''}
            </button>
            {showList &&
              (collaborators === null ? (
                <p className="px-2 py-3 text-center text-muted">Loading…</p>
              ) : collaborators.length === 0 ? (
                <div className="flex flex-col items-center gap-1.5 py-3 text-center">
                  <svg className="h-6 w-6 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="4" y="3" width="16" height="18" rx="2" />
                    <circle cx="12" cy="10" r="3" />
                    <path d="M8 17a4 4 0 0 1 8 0" />
                  </svg>
                  <span className="font-semibold text-ink">No collaborators here</span>
                </div>
              ) : (
                <ul className="mt-1 space-y-0.5">
                  {collaborators.map((c) => (
                    <li key={c.id} className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5">
                      <Avatar m={c} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-ink">
                          {c.name} {c.id === meId && <span className="text-[10px] text-faint">You</span>}
                        </span>
                        <span className="block truncate text-[11px] text-muted">{c.email}</span>
                      </span>
                      {canEdit && (
                        <button type="button" disabled={busy} title={`Remove ${c.name}`} aria-label={`Remove ${c.name}`} onClick={() =>
                          run(async () => {
                            const list = await removeCollaborator(conversationId, c.id);
                            const t = collaboratorRemovedByYouText(c.name, c.id === meId, contactName); // confirmation for you
                            showToast(t.key, conversationId, t.message, t.detail);
                            return list;
                          })
                        } className="rounded-md px-1.5 py-0.5 text-faint hover:bg-surface-muted hover:text-danger disabled:opacity-50">
                          ✕
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ))}
          </div>

          {canEdit ? (
            <>
              <div className="p-2.5 pb-1">
                <div className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 focus-within:border-primary">
                  <svg className="h-4 w-4 shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <path d="m21 21-4.3-4.3" />
                  </svg>
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or email" aria-label="Search team members" className="w-full bg-transparent text-[13px] text-ink placeholder:text-faint outline-none" />
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-2.5">
                <p className={section}>
                  {caret(true)} Team member ({candidates.length})
                </p>
                <ul className="pb-1">
                  {candidates.map((m) => {
                    const on = picked.includes(m.id);
                    return (
                      <li key={m.id}>
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={on}
                          onClick={() => setPicked((p) => (on ? p.filter((x) => x !== m.id) : [...p, m.id]))}
                          className={`flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left ${on ? 'bg-primary-subtle' : 'hover:bg-surface-muted'}`}
                        >
                          <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px] font-bold ${on ? 'border-primary bg-primary text-on-primary' : 'border-line-strong'}`}>{on ? '✓' : ''}</span>
                          <Avatar m={m} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] text-ink">{m.name}</span>
                            <span className="block truncate text-[11px] text-muted">{m.email}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                  {candidates.length === 0 && <li className="px-1.5 py-2 text-muted">{query.trim() ? 'No one matches' : 'Everyone is already a collaborator'}</li>}
                </ul>
              </div>
              {error && <p className="mx-2.5 mb-1 rounded-lg bg-danger-soft px-2.5 py-1.5 text-danger">{error}</p>}
              <div className="border-t border-line-soft p-2.5">
                <button
                  type="button"
                  disabled={busy || picked.length === 0}
                  onClick={() => run(() => addCollaborators(conversationId, picked))}
                  className="w-full rounded-lg bg-primary py-2 text-xs font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-40"
                >
                  {busy ? 'Adding…' : picked.length > 1 ? `Add ${picked.length} collaborators` : 'Add collaborators'}
                </button>
              </div>
            </>
          ) : (
            <p className="p-3 text-center text-[11px] text-muted">Only admins, supervisors and the chat&apos;s assignee can change collaborators.</p>
          )}
        </div>
      )}
    </div>
  );
}
