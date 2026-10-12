'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchWorkspaceMembers } from '@/lib/assignees';
import { type TeamMember, createJoinLink, fetchMembers, inviteMember, removeMember, updateMemberRole } from '@/lib/members';
import { ASSIGNABLE_ROLES, ROLE_STYLES, isAdminRole } from '@/lib/roles';
import { buttonClass, inputClass } from '../AuthShell';
import { RoleBadge } from '../RoleBadge';

type Row = { userId: string; name: string; email?: string; role: string; isOwner: boolean };

// Team: everyone sees who is in the workspace and their role. Admins also invite people, change roles,
// remove members and create a signup link (the server enforces all of it).
export function TeamSection({ meId, role }: { meId: string; role: string | undefined }) {
  const admin = isAdminRole(role);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);

  const load = useCallback(() => {
    const request: Promise<Row[]> = admin
      ? fetchMembers()
      : fetchWorkspaceMembers().then((list) => list.map((m) => ({ userId: m.id, name: m.name, role: m.role, isOwner: m.role === 'owner' })));
    request.then(setRows).catch((err) => setError((err as Error).message));
  }, [admin]);
  useEffect(load, [load]);

  async function attempt(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function onInvite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    attempt('invite', async () => {
      const r = await inviteMember({ name: String(form.get('name')), email: String(form.get('email')), role: String(form.get('role')) });
      setNotice(
        !r.invited
          ? `${r.member.name} already had an account and was added to this workspace.`
          : r.emailSent
            ? `Invite sent to ${r.member.email}. They'll choose a password from the email.`
            : `${r.member.email} was added, but the invite email couldn't be sent. They can use "Forgot password" to set one.`,
      );
      formEl.reset();
      load();
    });
  }

  return (
    <section className="rounded-2xl border border-line bg-surface p-6 shadow-xs">
      <h2 className="text-sm font-bold text-ink flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary-soft text-primary text-xs">👥</span>
        Team
      </h2>
      <p className="mt-2 text-xs text-muted leading-relaxed">
        <RoleBadge role="admin" /> manages users and settings · <RoleBadge role="supervisor" /> manages team chats and
        assignments · <RoleBadge role="agent" /> handles customer conversations
        {admin ? '' : '. Only admins can change the team.'}
      </p>

      {error && <div className="mt-3 rounded-xl bg-danger-soft p-3 text-xs font-medium text-danger">{error}</div>}
      {notice && <div className="mt-3 rounded-xl bg-success-soft p-3 text-xs font-medium text-success">{notice}</div>}

      <ul className="mt-4 divide-y divide-line-soft rounded-xl border border-line/80">
        {!rows && <li className="px-3 py-2.5 text-xs text-muted">Loading…</li>}
        {rows?.map((m) => {
          const locked = m.isOwner || m.userId === meId; // the server refuses these too
          return (
            <li key={m.userId} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-xs">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-bold text-on-primary">
                {m.name.charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 font-semibold text-ink">
                  <span className="truncate">{m.name}</span>
                  <RoleBadge role={m.role} />
                  {m.isOwner && <span className="text-[10px] font-medium text-faint">Owner</span>}
                  {m.userId === meId && <span className="text-[10px] font-medium text-faint">You</span>}
                </p>
                {m.email && <p className="truncate text-[11px] text-muted">{m.email}</p>}
              </div>
              {admin && (
                <>
                  <select
                    aria-label={`Role for ${m.name}`}
                    value={m.isOwner ? 'admin' : m.role}
                    disabled={locked || busy !== null}
                    onChange={(e) => {
                      const next = e.target.value;
                      attempt(`role:${m.userId}`, async () => {
                        await updateMemberRole(m.userId, next);
                        setNotice(`${m.name} is now ${ROLE_STYLES[next as keyof typeof ROLE_STYLES].label}.`);
                        load();
                      });
                    }}
                    title={locked ? (m.isOwner ? "The workspace owner's role can't be changed" : "You can't change your own role") : undefined}
                    className="rounded-lg border border-line bg-surface px-2 py-1 text-xs text-body disabled:opacity-50"
                  >
                    {ASSIGNABLE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_STYLES[r].label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={locked || busy !== null}
                    onClick={() => {
                      if (!confirm(`Remove ${m.name} from this workspace? They lose access immediately; their account isn't deleted.`)) return;
                      attempt(`remove:${m.userId}`, async () => {
                        await removeMember(m.userId);
                        setNotice(`${m.name} was removed from this workspace.`);
                        load();
                      });
                    }}
                    className="rounded-lg px-2 py-1 text-xs font-medium text-danger hover:bg-danger-soft disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    Remove
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>

      {admin && (
        <>
          <form onSubmit={onInvite} className="mt-5 space-y-3">
            <h3 className="text-xs font-bold text-ink">Add a person</h3>
            <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <input name="name" required maxLength={191} placeholder="Name" className={inputClass} />
              <input name="email" required type="email" placeholder="Email" className={inputClass} />
              <select name="role" defaultValue="agent" aria-label="Role" className={inputClass}>
                {ASSIGNABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_STYLES[r].label}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-[11px] text-muted">
              New emails get an invite to choose a password. If the person already has an account, they're added to this
              workspace with the role you pick.
            </p>
            <button disabled={busy !== null} className={buttonClass}>
              {busy === 'invite' ? 'Adding…' : 'Add to team'}
            </button>
          </form>

          <div className="mt-5 space-y-2">
            <h3 className="text-xs font-bold text-ink">Signup link</h3>
            <p className="text-[11px] text-muted">
              Anyone with this link can create an account (or add their existing one) and join as an <RoleBadge role="agent" />.
              You can promote them afterwards. Links expire after 7 days.
            </p>
            {link ? (
              <div className="flex items-center gap-2">
                <input readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} className={`${inputClass} font-mono text-[11px]`} />
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(link.url).then(() => setNotice('Signup link copied.'))}
                  className="shrink-0 rounded-lg border border-line px-3 py-2 text-xs font-medium text-body hover:bg-surface-muted"
                >
                  Copy
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  attempt('link', async () => {
                    const { token, expiresAt } = await createJoinLink();
                    setLink({ url: `${window.location.origin}/register?join=${encodeURIComponent(token)}`, expiresAt });
                  })
                }
                className="rounded-lg border border-line px-3 py-2 text-xs font-medium text-body hover:bg-surface-muted disabled:opacity-50"
              >
                Create signup link
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
