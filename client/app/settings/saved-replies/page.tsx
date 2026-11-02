'use client';

import { useCallback, useEffect, useState } from 'react';
import { type SavedReply, canManageQuickReplies, createQuickReply, deleteQuickReply, fetchSavedReplies, updateQuickReply } from '@/lib/quickReplies';
import { formatDateTime } from '@/lib/time';
import { showToast } from '@/lib/toasts';
import { AppShell } from '../../AppShell';
import { inputClass } from '../../AuthShell';
import { ConfirmDialog } from '../../ConfirmDialog';
import { SettingsShell } from '../SettingsShell';
import { TableSkeleton } from '../Skeleton';

// Settings → Saved replies: this workspace's quick replies (type / in a chat to use one). Searchable here. Owners,
// admins and supervisors add, edit and delete them; everyone else sees the list read-only. The server checks the same.
export default function SavedRepliesPage() {
  return (
    <AppShell>
      {(me) => (
        <SettingsShell me={me} section="Inbox settings" title="Saved replies">
          <SavedReplies canManage={canManageQuickReplies(me.role)} />
        </SettingsShell>
      )}
    </AppShell>
  );
}

const iconButton = 'flex h-8 w-8 items-center justify-center rounded-lg text-body-soft transition hover:bg-surface-muted hover:text-ink';

function SavedReplies({ canManage }: { canManage: boolean }) {
  const [search, setSearch] = useState('');
  const [replies, setReplies] = useState<SavedReply[] | null>(null);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<{ reply: SavedReply | null } | null>(null);
  const [deleting, setDeleting] = useState<SavedReply | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const load = useCallback(
    (term: string) =>
      fetchSavedReplies(term.trim())
        .then((r) => {
          setReplies(r);
          setError('');
        })
        .catch((e) => setError((e as Error).message)),
    [],
  );
  useEffect(() => {
    const t = setTimeout(() => load(search), 250);
    return () => clearTimeout(t);
  }, [search, load]);

  async function remove(reply: SavedReply) {
    setBusy(true);
    setDeleteError('');
    try {
      await deleteQuickReply(reply.id);
      setDeleting(null);
      showToast(`saved-replies:${Date.now()}`, '', `Saved reply “/${reply.shortcut}” deleted.`, 'Saved replies');
      load(search);
    } catch (e) {
      setDeleteError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-4xl">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xs text-muted">
          Type <span className="rounded bg-surface-strong px-1 font-mono">/</span> in a chat's message box to insert one of these.
        </p>
        {canManage && (
          <button type="button" onClick={() => setEditor({ reply: null })} className="ml-auto rounded-lg bg-primary px-5 py-2.5 text-[13px] font-semibold text-on-primary transition hover:bg-primary-hover">
            Add Reply
          </button>
        )}
      </div>
      {!canManage && <p className="mt-2 text-xs text-muted">Adding, editing and deleting saved replies is for owners, admins and supervisors.</p>}
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by shortcut, text or category" aria-label="Search saved replies" className={`${inputClass} mt-4 max-w-md`} />
      {error && <p className="mt-3 text-xs text-danger">{error}</p>}
      {replies === null ? (
        <TableSkeleton rows={4} />
      ) : replies.length === 0 ? (
        <p className="mt-6 text-sm text-muted">{search.trim() ? `No saved reply matches “${search.trim()}”.` : 'No saved replies yet.'}</p>
      ) : (
        <ul className="mt-4 divide-y divide-line-soft rounded-xl border border-line bg-surface">
          {replies.map((r) => (
            <li key={r.id} className="flex gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[13px] font-semibold text-primary">/{r.shortcut}</span>
                  {r.category && <span className="rounded-full bg-surface-strong px-2 py-0.5 text-[10px] font-semibold text-body-soft">{r.category.replace(/_/g, ' ')}</span>}
                </div>
                {r.description && <p className="mt-1 whitespace-pre-wrap text-[13px] text-body">{r.description}</p>}
                <AuditLine reply={r} />
              </div>
              {canManage && (
                <span className="flex shrink-0 items-start gap-1">
                  <button type="button" onClick={() => setEditor({ reply: r })} aria-label={`Edit /${r.shortcut}`} title="Edit" className={iconButton}>
                    <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDeleteError('');
                      setDeleting(r);
                    }}
                    aria-label={`Delete /${r.shortcut}`}
                    title="Delete"
                    className={`${iconButton} hover:text-danger`}
                  >
                    <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
                    </svg>
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {replies && replies.length >= 100 && <p className="mt-2 text-[11px] text-faint">Showing the first 100. Search to find others.</p>}

      {editor && (
        <ReplyEditor
          reply={editor.reply}
          onClose={() => setEditor(null)}
          onSaved={(message) => {
            setEditor(null);
            load(search);
            showToast(`saved-replies:${Date.now()}`, '', message, 'Saved replies');
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete the saved reply “/${deleting.shortcut}”?`}
          body="It will no longer be offered when typing / in a chat."
          yes="Delete"
          no="Cancel"
          error={deleteError}
          danger
          busy={busy}
          onYes={() => remove(deleting)}
          onNo={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

// "Added by X · date" and, once changed, "Edited by Y · date" (imported replies have dates but no name here)
function AuditLine({ reply: r }: { reply: SavedReply }) {
  const added = r.createdAt ? `Added${r.createdByName ? ` by ${r.createdByName}` : ''} · ${formatDateTime(r.createdAt)}` : '';
  const edited =
    r.updatedAt && r.updatedAt !== r.createdAt && (r.updatedByName || !r.createdByName)
      ? `Edited${r.updatedByName ? ` by ${r.updatedByName}` : ''} · ${formatDateTime(r.updatedAt)}`
      : '';
  if (!added && !edited) return null;
  return (
    <p className="mt-1.5 flex flex-wrap gap-x-3 text-[11px] text-faint">
      {added && <span>{added}</span>}
      {edited && <span>{edited}</span>}
    </p>
  );
}

// Add or edit: shortcut, message text and category
function ReplyEditor({ reply, onClose, onSaved }: { reply: SavedReply | null; onClose: () => void; onSaved: (message: string) => void }) {
  const [shortcut, setShortcut] = useState(reply?.shortcut ?? '');
  const [description, setDescription] = useState(reply?.description ?? '');
  const [category, setCategory] = useState(reply?.category?.replace(/_/g, ' ') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const s = shortcut.trim().replace(/^\/+/, '');
    if (!s) return setError('Enter a shortcut');
    if (!/^[A-Za-z0-9_-]+$/.test(s)) return setError('Shortcut can only use letters, numbers, _ and - (no spaces)');
    if (!description.trim()) return setError('Enter the message text');
    setBusy(true);
    setError('');
    try {
      const input = { shortcut: s, description, category: category.trim() };
      if (reply) await updateQuickReply(reply.id, input);
      else await createQuickReply(input);
      onSaved(reply ? `Saved reply “/${s}” saved.` : `Saved reply “/${s}” added.`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const label = 'mt-5 mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-muted';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form role="dialog" aria-modal="true" aria-labelledby="reply-editor-title" onSubmit={save} className="w-full max-w-lg rounded-2xl bg-surface p-7 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 id="reply-editor-title" className="text-lg font-bold text-ink">
            {reply ? 'Edit saved reply' : 'Add saved reply'}
          </h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-lg text-body-soft hover:bg-surface-muted">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <label htmlFor="reply-shortcut" className={label}>
          Shortcut
        </label>
        <div className="flex items-center gap-1">
          <span className="font-mono text-[15px] text-muted">/</span>
          <input id="reply-shortcut" autoFocus value={shortcut} onChange={(e) => setShortcut(e.target.value)} maxLength={51} placeholder="e.g. stockcheck" className={`${inputClass} font-mono`} />
        </div>
        <p className="mt-1 text-[11px] text-faint">Letters, numbers, _ and - only. No spaces.</p>
        <label htmlFor="reply-text" className={label}>
          Message text
        </label>
        <textarea id="reply-text" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4096} rows={6} placeholder="The message this inserts" className={`${inputClass} resize-y`} />
        <p className="mt-1 text-right text-[11px] text-faint">{description.length}/4096</p>
        <label htmlFor="reply-category" className={label}>
          Category <span className="normal-case tracking-normal text-faint">(optional)</span>
        </label>
        <input id="reply-category" value={category} onChange={(e) => setCategory(e.target.value)} maxLength={50} placeholder="e.g. car tyres" className={inputClass} />
        {error && <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
        <div className="mt-7 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-lg px-4 py-2 text-[13px] text-body-soft hover:bg-surface-muted">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="rounded-lg bg-primary px-6 py-2 text-[13px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-60">
            {busy ? 'Saving…' : reply ? 'Save' : 'Add'}
          </button>
        </div>
      </form>
    </div>
  );
}
