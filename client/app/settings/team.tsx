'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API_URL, errorCode, getToken } from '@/lib/api';
import { fetchWorkspaceMembers } from '@/lib/assignees';
import { type TeamMember, createJoinLink, fetchMembers, inviteMember, removeMember, setMemberActive, updateMember, updateMemberRole } from '@/lib/members';
import { DEFAULT_NEW_USER_PASSWORD, passwordsProblem, suggestPassword } from '@/lib/password';
import { ASSIGNABLE_ROLES, ROLE_STYLES, isAdminRole } from '@/lib/roles';
import { buttonClass, inputClass } from '../AuthShell';
import { RoleBadge } from '../RoleBadge';

type Row = { userId: string; name: string; email?: string; role: string; isOwner: boolean; status?: string; active?: boolean };

// Team: everyone sees who is in the workspace and their role. Admins also invite people, change roles,
// remove members and create a signup link (the server enforces all of it).
export function TeamSection({ meId, role }: { meId: string; role: string | undefined }) {
  const admin = isAdminRole(role);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  // Create form: the password pair is optional (blank = invite email); Edit form: one row open at a time
  const [showPassword, setShowPassword] = useState(true); // the default password is shown, so the admin sees what they're giving out
  const [editing, setEditing] = useState<string | null>(null);
  const [showEditPassword, setShowEditPassword] = useState(false);
  // "Add a person" with a password for an email that already has an account elsewhere: offer to add them as they are
  const [existingAccount, setExistingAccount] = useState<{ name: string; email: string; role: string } | null>(null);
  // In-app Yes/No dialog for deactivate, reactivate and remove (the browser's confirm() popup can be blocked)
  const [pending, setPending] = useState<{ title: string; body: string; yes: string; danger: boolean; run: () => Promise<void> } | null>(null);

  const load = useCallback(() => {
    const request: Promise<Row[]> = admin
      ? fetchMembers()
      : fetchWorkspaceMembers().then((list) => list.map((m) => ({ userId: m.id, name: m.name, role: m.role, isOwner: m.role === 'owner' })));
    request.then(setRows).catch((err) => setError((err as Error).message));
  }, [admin]);
  useEffect(load, [load]);

  // Admins' list stays live: the server announces every member added, role change (member:permissions) and
  // removal (member:removed), so the Teams tab reloads from the database instead of guessing
  useEffect(() => {
    if (!admin) return;
    const socket = io(API_URL, { auth: { token: getToken() } });
    socket.on('member:permissions', load);
    socket.on('member:removed', load);
    return () => {
      socket.disconnect();
    };
  }, [admin, load]);

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
    const password = String(form.get('password') ?? '');
    const confirm = String(form.get('confirm') ?? '');
    if (password || confirm) {
      const problem = passwordsProblem(password, confirm);
      if (problem) {
        setError(problem);
        return;
      }
    }
    const person = { name: String(form.get('name')), email: String(form.get('email')), role: String(form.get('role')) };
    setExistingAccount(null);
    attempt('invite', async () => {
      let r;
      try {
        r = await inviteMember({ ...person, ...(password ? { password } : {}) });
      } catch (err) {
        // Their account lives in another workspace too, so only they can change its password. Not an error for the
        // admin: offer to add them as they are (the pre-filled default password is simply not used)
        if (password && errorCode(err) === 'ACCOUNT_EXISTS') {
          setExistingAccount(person);
          return;
        }
        throw err;
      }
      setNotice(
        !r.created
          ? `${r.member.name} already had an account and was added to this workspace.`
          : !r.invited
            ? `${r.member.name} was added with the password you set. They can sign in now with ${r.member.email}.`
            : r.emailSent
              ? `Invite sent to ${r.member.email}. They'll choose a password from the email.`
              : `${r.member.email} was added, but the invite email couldn't be sent. They can use "Forgot password" to set one.`,
      );
      formEl.reset(); // back to the default password for the next person
      load();
    });
  }

  function onEdit(e: React.FormEvent<HTMLFormElement>, m: Row) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    const password = String(form.get('password') ?? '');
    const confirm = String(form.get('confirm') ?? '');
    if (password || confirm) {
      const problem = passwordsProblem(password, confirm);
      if (problem) {
        setError(problem);
        return;
      }
    }
    attempt(`edit:${m.userId}`, async () => {
      await updateMember(m.userId, { ...(name && name !== m.name ? { name } : {}), ...(password ? { password } : {}) });
      setNotice(password ? `${name || m.name} was updated and given a new password; they're signed out everywhere.` : `${name || m.name} was updated.`);
      setEditing(null);
      setShowEditPassword(false);
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
      {existingAccount && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-muted p-3 text-xs text-body">
          <span>
            <span className="font-semibold">{existingAccount.email}</span> already has an account (in another workspace). Add them here as{' '}
            {ROLE_STYLES[existingAccount.role as keyof typeof ROLE_STYLES]?.label ?? existingAccount.role} with the password and details they already have?
            The password typed above is not used.
          </span>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => {
              const person = existingAccount;
              attempt('invite', async () => {
                const r = await inviteMember(person);
                setNotice(`${r.member.name} already had an account and was added to this workspace with their existing password.`);
                setExistingAccount(null);
                load();
              });
            }}
            className={`${buttonClass} w-auto px-3 py-1.5`}
          >
            {busy === 'invite' ? 'Adding…' : 'Add with their existing password'}
          </button>
          <button type="button" onClick={() => setExistingAccount(null)} className="px-2 py-1 text-xs text-muted hover:text-body">
            Cancel
          </button>
        </div>
      )}
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
                  {m.status && <StatusBadge status={m.status} />}
                </p>
                {m.email && <p className="truncate text-[11px] text-muted">{m.email}</p>}
                {admin && (
                  <p className="truncate font-mono text-[10px] text-faint" title="User ID (unique, never changes)">
                    ID {m.userId}
                  </p>
                )}
              </div>
              {admin && (
                <>
                  {(!m.isOwner || m.userId === meId) && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => {
                        setError('');
                        setShowEditPassword(false);
                        setEditing(editing === m.userId ? null : m.userId);
                      }}
                      className="rounded-lg border border-line px-2 py-1 text-xs font-medium text-body hover:bg-surface-muted disabled:opacity-40"
                    >
                      {editing === m.userId ? 'Close' : 'Edit'}
                    </button>
                  )}
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
                      setPending({
                        title: `Remove ${m.name} from this workspace?`,
                        body: "They lose access immediately and their chats go back to New Leads. Their account isn't deleted.",
                        yes: 'Yes, remove',
                        danger: true,
                        run: async () => {
                          await removeMember(m.userId);
                          setNotice(`${m.name} was removed from this workspace.`);
                          load();
                        },
                      });
                    }}
                    className="rounded-lg px-2 py-1 text-xs font-medium text-danger hover:bg-danger-soft disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    Remove
                  </button>
                  {!locked && (
                    <ActiveToggle
                      name={m.name}
                      active={m.active !== false}
                      disabled={busy !== null}
                      onChange={(next) =>
                        setPending({
                          title: next ? `Activate ${m.name}?` : `Deactivate ${m.name}?`,
                          body: next
                            ? 'They can sign in to this workspace again with their existing password.'
                            : "They are signed out at once and can't sign in to this workspace until you activate them again. Their chats and history stay.",
                          yes: next ? 'Yes, activate' : 'Yes, deactivate',
                          danger: !next,
                          run: async () => {
                            await setMemberActive(m.userId, next);
                            setNotice(next ? `${m.name} is active again and can sign in.` : `${m.name} was deactivated and signed out.`);
                            load();
                          },
                        })
                      }
                    />
                  )}
                </>
              )}
              {admin && editing === m.userId && (
                <form onSubmit={(e) => onEdit(e, m)} className="mt-1 w-full space-y-2 rounded-xl border border-line-soft bg-surface-muted p-3">
                  <h4 className="text-[11px] font-bold text-ink">Edit {m.name}</h4>
                  <input name="name" defaultValue={m.name} required maxLength={191} placeholder="Name" aria-label={`Name for ${m.name}`} className={inputClass} />
                  {m.userId !== meId ? (
                    <>
                      <PasswordPair show={showEditPassword} onToggle={() => setShowEditPassword((v) => !v)} idPrefix={`edit-${m.userId}`} label="New password" />
                      <p className="text-[11px] text-muted">
                        Leave the password blank to keep theirs. A new one signs them out everywhere; only a hash is stored.
                      </p>
                    </>
                  ) : (
                    <p className="text-[11px] text-muted">To change your own password, use "Forgot password" on the sign-in page.</p>
                  )}
                  <div className="flex gap-2">
                    <button disabled={busy !== null} className={buttonClass}>
                      {busy === `edit:${m.userId}` ? 'Saving…' : 'Save changes'}
                    </button>
                    <button type="button" onClick={() => setEditing(null)} className="rounded-lg border border-line px-3 py-2 text-xs font-medium text-body hover:bg-surface-muted">
                      Cancel
                    </button>
                  </div>
                </form>
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
            {/* Password directly below the name / email / role fields: set the first password here, or leave blank to invite */}
            <PasswordPair show={showPassword} onToggle={() => setShowPassword((v) => !v)} idPrefix="new" label="Password" defaultValue={DEFAULT_NEW_USER_PASSWORD} />
            <p className="text-[11px] text-muted">
              Every new user starts with the default password <span className="font-mono font-semibold text-body">{DEFAULT_NEW_USER_PASSWORD}</span>{' '}
              (change it here if you like, 8+ characters with a letter and a number; only a hash is stored). They can change
              it themselves later under <span className="font-semibold text-body">My account</span>. Clear the field to email
              them an invite instead. If the person already has an account, they're added with the role you pick and keep
              their own password.
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

      {pending && (
        <ConfirmDialog
          title={pending.title}
          body={pending.body}
          yes={pending.yes}
          danger={pending.danger}
          busy={busy !== null}
          onNo={() => setPending(null)}
          onYes={() => {
            const { run } = pending;
            attempt('confirm', async () => {
              await run();
              setPending(null);
            }).then(() => setPending(null));
          }}
        />
      )}
    </section>
  );
}

// Yes / No confirmation shown inside the page (same look as the Clear chat dialog). Esc or clicking outside = No.
function ConfirmDialog({ title, body, yes, danger, busy, onYes, onNo }: { title: string; body: string; yes: string; danger: boolean; busy: boolean; onYes: () => void; onNo: () => void }) {
  const noRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    noRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onNo();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onNo]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-shadow/40 p-4 sm:items-center" onClick={() => !busy && onNo()}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="team-confirm-title" onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-2xl bg-surface p-5 text-ink-soft shadow-xl">
        <h2 id="team-confirm-title" className="text-sm font-bold text-ink">
          {title}
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-muted">{body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button ref={noRef} type="button" disabled={busy} onClick={onNo} className="rounded-lg px-3 py-1.5 text-xs font-medium text-body-soft hover:bg-surface-strong disabled:opacity-50">
            No
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onYes}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold text-on-primary disabled:opacity-50 ${danger ? 'bg-danger hover:opacity-90' : 'bg-primary hover:bg-primary-hover'}`}
          >
            {busy ? 'Working…' : yes}
          </button>
        </div>
      </div>
    </div>
  );
}

// active: can sign in · invited: hasn't chosen a password from the invite email yet · inactive: deactivated here
function StatusBadge({ status }: { status: string }) {
  const look =
    status === 'invited'
      ? { label: 'Invited', title: 'Added by an admin; waiting for them to choose a password from the invite email', className: 'bg-warning-soft text-warning' }
      : status === 'inactive'
        ? { label: 'Inactive', title: "Deactivated by an admin: can't sign in to this workspace until reactivated", className: 'bg-surface-strong text-muted' }
        : { label: 'Active', title: 'Can sign in', className: 'bg-success-soft text-success' };
  return (
    <span title={look.title} className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${look.className}`}>
      {look.label}
    </span>
  );
}

// Password + Confirm password with one show/hide toggle (same eye icons as the sign-up page) and a Suggest
// button that fills both with a random password and reveals it, so the admin can pass it on
function PasswordPair({ show, onToggle, idPrefix, label, defaultValue }: { show: boolean; onToggle: () => void; idPrefix: string; label: string; defaultValue?: string }) {
  const type = show ? 'text' : 'password';
  function suggest() {
    const value = suggestPassword();
    for (const id of [`${idPrefix}-password`, `${idPrefix}-confirm`]) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.value = value;
    }
    if (!show) onToggle();
  }
  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
      <div className="relative">
        <input
          id={`${idPrefix}-password`}
          name="password"
          type={type}
          defaultValue={defaultValue}
          autoComplete="new-password"
          maxLength={72}
          placeholder={label}
          aria-label={label}
          className={`${inputClass} pr-10`}
        />
        <button
          type="button"
          onClick={onToggle}
          aria-label={show ? 'Hide password' : 'Show password'}
          aria-pressed={show}
          className="absolute inset-y-0 right-0 flex items-center pr-3 text-faint hover:text-body-soft focus:outline-hidden"
          tabIndex={-1}
        >
          {show ? (
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          ) : (
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          )}
        </button>
      </div>
      <input
        id={`${idPrefix}-confirm`}
        name="confirm"
        type={type}
        defaultValue={defaultValue}
        autoComplete="new-password"
        maxLength={72}
        placeholder={`Confirm ${label.toLowerCase()}`}
        aria-label={`Confirm ${label.toLowerCase()}`}
        className={inputClass}
      />
      
    </div>
  );
}

// Account status switch (admins only): Active <-> Inactive. The confirmation happens in onChange's caller.
function ActiveToggle({ name, active, disabled, onChange }: { name: string; active: boolean; disabled: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      aria-label={`${name} is ${active ? 'active' : 'inactive'}; click to ${active ? 'deactivate' : 'activate'}`}
      title={active ? "Deactivate: they can't sign in here until reactivated; nothing is deleted" : 'Activate: they can sign in to this workspace again'}
      disabled={disabled}
      onClick={() => onChange(!active)}
      className="flex items-center gap-1.5 text-[11px] font-medium text-body disabled:opacity-40"
    >
      <span className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition ${active ? 'bg-success' : 'bg-line-strong'}`}>
        <span className={`inline-block h-3 w-3 rounded-full bg-surface shadow-xs transition ${active ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
      </span>
      {active ? 'Active' : 'Inactive'}
    </button>
  );
}
