'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { isAdminRole } from '@/lib/roles';
import { type Template, deleteTemplate, fetchAllTemplates } from '@/lib/templates';
import { showToast } from '@/lib/toasts';
import { AppShell, type Me } from '../../AppShell';
import { ConfirmDialog } from '../../ConfirmDialog';
import { TableSkeleton } from '../Skeleton';
import { SettingsShell } from '../SettingsShell';
import { TemplateEditor } from './TemplateEditor';

// Settings → Inbox settings → Message templates (owners/admins): the WhatsApp number's templates with their review
// status at Meta (approved, pending, rejected with the reason, paused, disabled); create one, edit it (Meta reviews
// it again) or delete it. Templates live at Meta; this page reads and changes them there.
export default function TemplatesPage() {
  return (
    <AppShell>
      {(me) => (
        <SettingsShell me={me} section="Inbox settings" title="Message templates">
          <Templates me={me} />
        </SettingsShell>
      )}
    </AppShell>
  );
}

const STATUS_STYLE: Record<string, string> = {
  APPROVED: 'bg-success-soft text-success',
  PENDING: 'bg-warning-soft text-warning',
  IN_APPEAL: 'bg-warning-soft text-warning',
  REJECTED: 'bg-danger-soft text-danger',
  PAUSED: 'bg-surface-strong text-body-soft',
  DISABLED: 'bg-surface-strong text-muted',
};
const label = (v: string) => v.charAt(0) + v.slice(1).toLowerCase().replace(/_/g, ' ');
// Meta's rejection codes in plain words
const REASONS: Record<string, string> = {
  ABUSIVE_CONTENT: 'Abusive content',
  INCORRECT_CATEGORY: 'Wrong category for its content',
  INVALID_FORMAT: 'Invalid format (variables, length or wording)',
  PROMOTIONAL: 'Promotional content in a Utility template',
  SCAM: 'Looks like a scam',
  TAG_CONTENT_MISMATCH: "Content doesn't match its category",
};

function Templates({ me }: { me: Me }) {
  const router = useRouter();
  const admin = isAdminRole(me.role);
  const [list, setList] = useState<Template[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [editing, setEditing] = useState<{ template: Template | null } | null>(null);
  const [deleting, setDeleting] = useState<Template | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setError('');
    return fetchAllTemplates()
      .then(setList)
      .catch((e) => {
        setList([]);
        setError((e as Error).message);
      });
  }, []);
  useEffect(() => {
    if (!admin) router.replace('/settings');
    else load();
  }, [admin, router, load]);
  if (!admin) return null;

  const q = query.trim().toLowerCase();
  const shown = (list ?? []).filter(
    (t) => (!status || t.status === status) && (!category || t.category === category) && (!q || t.name.includes(q) || t.body.toLowerCase().includes(q)),
  );
  const counts = (list ?? []).reduce<Record<string, number>>((n, t) => ({ ...n, [t.status]: (n[t.status] ?? 0) + 1 }), {});
  const connected = !!me.workspace.whatsapp;

  async function remove(t: Template) {
    setBusy(true);
    try {
      await deleteTemplate(t.name, t.id);
      showToast(`tpl:${Date.now()}`, '', `Template “${t.name}” (${t.language}) deleted.`, 'Message templates');
      setDeleting(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  }

  const select = 'h-10 rounded-lg border border-line bg-surface px-3 text-[13px] text-body cursor-pointer';
  return (
    <div className="max-w-6xl">
      <p className="text-[13px] text-body-soft">
        Templates are the messages WhatsApp lets you start a chat with, or send after the 24-hour reply window has closed. Meta reviews each one before it can be
        used (usually within minutes, at most 24 hours).
      </p>
      {!connected ? (
        <div className="mt-6 rounded-xl border border-line bg-surface p-8 text-center">
          <p className="text-sm font-semibold text-ink">No WhatsApp number connected</p>
          <p className="mt-1 text-xs text-muted">Connect your WhatsApp Business number first; its templates appear here.</p>
        </div>
      ) : (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search templates"
              aria-label="Search templates"
              className="h-10 w-full max-w-xs rounded-lg border border-line bg-surface px-3 text-[13px] text-ink outline-hidden focus:border-primary"
            />
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className={select}>
              <option value="">All statuses</option>
              {['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED'].map((s) => (
                <option key={s} value={s}>
                  {label(s)} ({counts[s] ?? 0})
                </option>
              ))}
            </select>
            <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" className={select}>
              <option value="">All categories</option>
              {['MARKETING', 'UTILITY', 'AUTHENTICATION'].map((c) => (
                <option key={c} value={c}>
                  {label(c)}
                </option>
              ))}
            </select>
            <div className="ml-auto flex items-center gap-2">
              <button type="button" onClick={() => load()} className="h-10 rounded-lg px-3 text-[13px] text-body-soft hover:bg-surface-muted" title="Check Meta for status changes">
                Refresh
              </button>
              <button type="button" onClick={() => setEditing({ template: null })} className="h-10 rounded-lg bg-primary px-5 text-[13px] font-semibold text-on-primary hover:bg-primary-hover">
                Create template
              </button>
            </div>
          </div>
          {error && <p className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
          {list === null ? (
            <TableSkeleton rows={6} />
          ) : (
            <div className="mt-4 overflow-x-auto rounded-xl border border-line bg-surface">
              <table className="w-full text-left text-[13px]" aria-label="Message templates">
                <thead>
                  <tr className="border-b border-line bg-surface-muted text-[12px] font-semibold text-ink">
                    <th className="px-4 py-3">Template</th>
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3">Language</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="w-36 px-4 py-3" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {shown.map((t) => (
                    <tr key={t.id} data-template={t.name}>
                      <td className="max-w-md px-4 py-3">
                        <p className="font-medium text-ink">{t.name}</p>
                        <p className="mt-0.5 line-clamp-2 text-[12px] text-muted">{t.body || (t.category === 'AUTHENTICATION' ? 'One-time code (text written by Meta)' : '')}</p>
                      </td>
                      <td className="px-4 py-3 text-body">{label(t.category)}</td>
                      <td className="px-4 py-3 text-body">{t.language}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[t.status] ?? 'bg-surface-strong text-body'}`}>{label(t.status)}</span>
                        {t.rejectedReason && <p className="mt-1 max-w-[220px] text-[11px] text-danger">{REASONS[t.rejectedReason] ?? label(t.rejectedReason)}</p>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button type="button" onClick={() => setEditing({ template: t })} aria-label={`Edit ${t.name} (${t.language})`} className="rounded-lg px-2.5 py-1 text-[12px] font-medium text-primary hover:bg-primary/5">
                          Edit
                        </button>
                        <button type="button" onClick={() => setDeleting(t)} aria-label={`Delete ${t.name} (${t.language})`} className="rounded-lg px-2.5 py-1 text-[12px] font-medium text-danger hover:bg-danger-soft">
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!shown.length && (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-[13px] text-muted">
                        {list.length ? 'No templates match.' : 'No templates yet. Create your first one.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {editing && (
        <TemplateEditor
          template={editing.template}
          businessName={me.workspace.name}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            showToast(`tpl:${Date.now()}`, '', message, 'Message templates');
            load();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete “${deleting.name}” (${deleting.language})?`}
          body="It is deleted at Meta and can't be sent any more. A new template can't reuse this name for 30 days."
          yes="Delete"
          danger
          busy={busy}
          onYes={() => remove(deleting)}
          onNo={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
