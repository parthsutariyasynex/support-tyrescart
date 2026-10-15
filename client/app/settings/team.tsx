'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API_URL, errorCode, getToken } from '@/lib/api';
import { fetchWorkspaceMembers } from '@/lib/assignees';
import {
  type TeamMember,
  createJoinLink,
  fetchMembers,
  inviteMember,
  removeMember,
  setMemberActive,
  updateMember,
  updateMemberRole,
} from '@/lib/members';
import { passwordsProblem, suggestPassword } from '@/lib/password';
import { bindPresence, presenceOf, usePresence } from '@/lib/presence';
import { revalidateOnReturn } from '@/lib/revalidate';
import { ASSIGNABLE_ROLES, ROLE_STYLES, isAdminRole } from '@/lib/roles';
import { buttonClass, inputClass } from '../AuthShell';
import { ConfirmDialog } from '../ConfirmDialog';
import { PresenceDot } from '../PresenceDot';
import { RoleBadge } from '../RoleBadge';

type Row = {
  userId: string;
  name: string;
  email?: string;
  role: string;
  isOwner: boolean;
  status?: string;
  active?: boolean;
};

// Team: everyone sees who is in the workspace and their role. Admins also invite people, change roles,
// remove members and create a signup link (the server enforces all of it).
let cachedTeamRows: Row[] | null = null;

export function TeamSection({ meId, role }: { meId: string; role: string | undefined }) {
  const admin = isAdminRole(role);
  // Kept between visits so coming back to Teams shows the list at once (then refreshed from the server)
  const [rows, setRowsState] = useState<Row[] | null>(() => cachedTeamRows);
  const setRows = (r: Row[] | null) => {
    cachedTeamRows = r;
    setRowsState(r);
  };
  const presence = usePresence();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);

  // Search filter
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | 'admin' | 'supervisor' | 'agent'>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);

  // Create form: the password pair is optional (blank = invite email); Edit form: one row open at a time
  const [showPassword, setShowPassword] = useState(true);
  // A fresh random password for each new person (shown so the admin can read it; it is also emailed to them)
  const [generatedPassword, setGeneratedPassword] = useState(() => suggestPassword()); // default password is shown
  const [editing, setEditing] = useState<string | null>(null);
  const [showEditPassword, setShowEditPassword] = useState(false);

  // "Add a person" with a password for an email that already has an account elsewhere: offer to add them as they are
  const [existingAccount, setExistingAccount] = useState<{ name: string; email: string; role: string } | null>(null);

  // In-app Yes/No dialog for deactivate, reactivate and remove (the browser's confirm() popup can be blocked)
  const [pending, setPending] = useState<{
    title: string;
    body: string;
    yes: string;
    danger: boolean;
    run: () => Promise<void>;
  } | null>(null);

  const load = useCallback(() => {
    const request: Promise<Row[]> = admin
      ? fetchMembers()
      : fetchWorkspaceMembers().then((list) =>
          list.map((m) => ({ userId: m.id, name: m.name, role: m.role, isOwner: m.role === 'owner' })),
        );
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
    const unbindPresence = bindPresence(socket); // online / away / offline dots
    const stopRevalidate = revalidateOnReturn(load, socket); // back to this tab or reconnected: reload the list
    return () => {
      stopRevalidate();
      unbindPresence();
      socket.disconnect();
    };
  }, [admin, load]);

  // Non-admins have no live connection here: still reload when they come back to the tab
  useEffect(() => (admin ? undefined : revalidateOnReturn(load)), [admin, load]);

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
    const person = {
      name: String(form.get('name')),
      email: String(form.get('email')),
      role: String(form.get('role')),
    };
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
          ? r.emailSent
            ? `${r.member.name} already had an account and was added to this workspace. A login link was emailed to ${r.member.email}.`
            : `${r.member.name} already had an account and was added to this workspace (the email couldn't be sent).`
          : !r.invited
            ? r.emailSent
              ? `${r.member.name} was added. An email with the login link and the temporary password was sent to ${r.member.email}.`
              : `${r.member.name} was added with the password you set, but the email couldn't be sent. Share the login details with them yourself.`
            : r.emailSent
              ? `Invite sent to ${r.member.email}. They'll choose a password from the email.`
              : `${r.member.email} was added, but the invite email couldn't be sent. They can use "Forgot password" to set one.`,
      );
      formEl.reset();
      setGeneratedPassword(suggestPassword()); // a new password for the next person
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
      await updateMember(m.userId, {
        ...(name && name !== m.name ? { name } : {}),
        ...(password ? { password } : {}),
      });
      setNotice(
        password
          ? `${name || m.name} was updated and given a new password; they're signed out everywhere.`
          : `${name || m.name} was updated.`,
      );
      setEditing(null);
      setShowEditPassword(false);
      load();
    });
  }

  // Quick stats computed directly from rows
  const stats = useMemo(() => {
    if (!rows) return null;
    const total = rows.length;
    const activeCount = rows.filter((r) => r.active !== false).length;
    const onlineCount = rows.filter((r) => presenceOf(presence, r.userId) === 'online').length;
    const admins = rows.filter((r) => isAdminRole(r.role)).length;
    const supervisors = rows.filter((r) => r.role === 'supervisor').length;
    const agents = rows.filter((r) => r.role === 'agent').length;
    return { total, activeCount, onlineCount, admins, supervisors, agents };
  }, [rows, presence]);

  // Client-side search and role filtering
  const filteredRows = useMemo(() => {
    if (!rows) return null;
    return rows.filter((m) => {
      const matchesSearch =
        searchQuery.trim() === '' ||
        m.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (m.email && m.email.toLowerCase().includes(searchQuery.toLowerCase())) ||
        m.userId.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesRole =
        roleFilter === 'all'
          ? true
          : roleFilter === 'admin'
            ? isAdminRole(m.role)
            : m.role === roleFilter;

      return matchesSearch && matchesRole;
    });
  }, [rows, searchQuery, roleFilter]);

  function copyToClipboard(text: string, id: string) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
      });
    }
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary-soft text-primary shadow-2xs">
              <svg className="h-4.5 w-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </span>
            <h1 className="text-xl font-bold tracking-tight text-ink sm:text-2xl">Team Members</h1>
          </div>
          <p className="mt-1 text-xs text-muted sm:text-sm">
            Manage your workspace users, configure role permissions, and control team access.
          </p>
        </div>

        {admin && (
          <div className="flex items-center gap-2">
            <a
              href="#add-person"
              className="inline-flex items-center gap-2 rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-on-primary shadow-xs transition hover:bg-primary-hover active:scale-[0.99]"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <line x1="19" y1="8" x2="19" y2="14" />
                <line x1="22" y1="11" x2="16" y2="11" />
              </svg>
              <span>Add Member</span>
            </a>
          </div>
        )}
      </div>

      {/* KPI Stats Overview Cards: always rendered (placeholders while loading) so the page doesn't jump */}
      {(
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-2xl border border-line bg-surface p-4 shadow-xs">
            <div className="flex items-center justify-between text-muted">
              <span className="text-xs font-medium">Total Members</span>
              <svg className="h-4 w-4 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </div>
            <div className="mt-2 text-2xl font-bold text-ink">{stats?.total ?? '–'}</div>
            <div className="mt-0.5 text-[11px] text-faint">In workspace</div>
          </div>

          <div className="rounded-2xl border border-line bg-surface p-4 shadow-xs">
            <div className="flex items-center justify-between text-muted">
              <span className="text-xs font-medium">Active Accounts</span>
              <span className="h-2 w-2 rounded-full bg-success" />
            </div>
            <div className="mt-2 text-2xl font-bold text-ink">{stats?.activeCount ?? '–'}</div>
            <div className="mt-0.5 text-[11px] text-faint">Can sign in</div>
          </div>

          <div className="rounded-2xl border border-line bg-surface p-4 shadow-xs">
            <div className="flex items-center justify-between text-muted">
              <span className="text-xs font-medium">Online Now</span>
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
              </span>
            </div>
            <div className="mt-2 text-2xl font-bold text-ink">{stats?.onlineCount ?? '–'}</div>
            <div className="mt-0.5 text-[11px] text-faint">Live presence</div>
          </div>

          <div className="rounded-2xl border border-line bg-surface p-4 shadow-xs">
            <div className="flex items-center justify-between text-muted">
              <span className="text-xs font-medium">Role Breakdown</span>
              <svg className="h-4 w-4 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </div>
            <div className="mt-2 text-xs font-semibold text-ink sm:text-sm">
              <span className="text-primary">{stats?.admins ?? '–'}</span> Admin · <span className="text-secondary">{stats?.supervisors ?? '–'}</span> Sup · <span className="text-success">{stats?.agents ?? '–'}</span> Agent
            </div>
            <div className="mt-0.5 text-[11px] text-faint">Assigned permissions</div>
          </div>
        </div>
      )}

      {/* Role Guide Cards */}
      <div className="rounded-2xl border border-line bg-surface p-5 shadow-xs">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="h-4 w-4 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <h2 className="text-xs font-bold tracking-wide text-ink uppercase">Workspace Roles & Permissions</h2>
          </div>
          {!admin && (
            <span className="rounded-full bg-surface-strong px-2 py-0.5 text-[10px] font-semibold text-muted">
              View Only
            </span>
          )}
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col justify-between rounded-xl border border-line/60 bg-surface-muted/40 p-3.5">
            <div>
              <div className="flex items-center gap-2">
                <RoleBadge role="admin" />
                <span className="text-xs font-bold text-ink">Administrator</span>
              </div>
              <p className="mt-1.5 text-xs text-muted leading-relaxed">
                Full authority to manage team members, change roles, adjust WhatsApp configuration, and invite teammates.
              </p>
            </div>
          </div>

          <div className="flex flex-col justify-between rounded-xl border border-line/60 bg-surface-muted/40 p-3.5">
            <div>
              <div className="flex items-center gap-2">
                <RoleBadge role="supervisor" />
                <span className="text-xs font-bold text-ink">Supervisor</span>
              </div>
              <p className="mt-1.5 text-xs text-muted leading-relaxed">
                Supervises customer chat queues, reassigns conversations between agents, and accesses performance reports.
              </p>
            </div>
          </div>

          <div className="flex flex-col justify-between rounded-xl border border-line/60 bg-surface-muted/40 p-3.5">
            <div>
              <div className="flex items-center gap-2">
                <RoleBadge role="agent" />
                <span className="text-xs font-bold text-ink">Agent</span>
              </div>
              <p className="mt-1.5 text-xs text-muted leading-relaxed">
                Handles direct customer conversations, answers queries, manages lead chat status, and applies conversation tags.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Error & Notice Banners */}
      {error && (
        <div className="flex items-start justify-between rounded-2xl border border-danger-border bg-danger-soft p-4 text-xs font-medium text-danger shadow-xs">
          <div className="flex items-center gap-2.5">
            <svg className="h-4 w-4 shrink-0 text-danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{error}</span>
          </div>
          <button type="button" onClick={() => setError('')} className="ml-3 text-danger/70 hover:text-danger">
            ✕
          </button>
        </div>
      )}

      {notice && (
        <div className="flex items-start justify-between rounded-2xl border border-primary-soft-border bg-primary-subtle p-4 text-xs font-medium text-primary shadow-xs">
          <div className="flex items-center gap-2.5">
            <svg className="h-4 w-4 shrink-0 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <span>{notice}</span>
          </div>
          <button type="button" onClick={() => setNotice('')} className="ml-3 text-primary/70 hover:text-primary">
            ✕
          </button>
        </div>
      )}

      {existingAccount && (
        <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 text-xs shadow-xs sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5 text-body">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            </span>
            <span>
              <strong className="font-semibold text-ink">{existingAccount.email}</strong> already has an account. Add them as{' '}
              <strong className="font-semibold text-ink">
                {ROLE_STYLES[existingAccount.role as keyof typeof ROLE_STYLES]?.label ?? existingAccount.role}
              </strong>{' '}
              with their existing password?
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                const person = existingAccount;
                attempt('invite', async () => {
                  const r = await inviteMember(person);
                  setNotice(
                    r.emailSent
                      ? `${r.member.name} already had an account and was added to this workspace with their existing password. A login link was emailed to ${r.member.email}.`
                      : `${r.member.name} already had an account and was added to this workspace with their existing password.`,
                  );
                  setExistingAccount(null);
                  load();
                });
              }}
              className="rounded-xl bg-primary px-3.5 py-1.5 text-xs font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
            >
              {busy === 'invite' ? 'Adding…' : 'Add with existing password'}
            </button>
            <button
              type="button"
              onClick={() => setExistingAccount(null)}
              className="rounded-xl border border-line px-3 py-1.5 text-xs font-medium text-body hover:bg-surface-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Team Directory Table Card */}
      <section className="rounded-2xl border border-line bg-surface shadow-xs overflow-hidden">
        {/* Card Header & Controls */}
        <div className="border-b border-line p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-ink">Team Directory</h3>
                {rows && (
                  <span className="rounded-full bg-surface-strong px-2 py-0.5 text-[10px] font-semibold text-body">
                    {rows.length} {rows.length === 1 ? 'member' : 'members'}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-muted">View all teammates, their live status, and assigned permissions.</p>
            </div>

            {/* Search & Filter */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[200px] flex-1 sm:w-64 sm:flex-none">
                <svg className="absolute left-3 top-2.5 h-3.5 w-3.5 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search name, email, ID…"
                  aria-label="Search members"
                  className={`${inputClass} py-1.5 pl-9 text-xs`}
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-2 text-faint hover:text-body text-xs"
                    aria-label="Clear search"
                  >
                    ✕
                  </button>
                )}
              </div>

              <select
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value as any)}
                aria-label="Filter by role"
                className="rounded-xl border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-body hover:bg-surface-muted"
              >
                <option value="all">All Roles</option>
                <option value="admin">Admins</option>
                <option value="supervisor">Supervisors</option>
                <option value="agent">Agents</option>
              </select>

              <button
                type="button"
                onClick={load}
                title="Refresh member list"
                aria-label="Refresh member list"
                className="flex h-8 w-8 items-center justify-center rounded-xl border border-line text-faint hover:bg-surface-muted hover:text-body"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Directory List / Table */}
        <div className="divide-y divide-line-soft">
          {!rows && (
            <div className="flex h-[73px] items-center justify-center gap-3 text-center">
              <svg className="h-5 w-5 animate-spin text-primary" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <p className="text-xs text-muted">Loading workspace members…</p>
            </div>
          )}

          {rows && filteredRows?.length === 0 && (
            <div className="py-12 text-center">
              <p className="text-xs font-semibold text-ink">No members found</p>
              <p className="mt-1 text-xs text-muted">Try adjusting your search query or role filter.</p>
            </div>
          )}

          {filteredRows?.map((m) => {
            const locked = m.isOwner || m.userId === meId;
            const userPresence = presenceOf(presence, m.userId);
            const isEditing = editing === m.userId;

            return (
              <div key={m.userId} className="transition-colors hover:bg-surface-muted/30">
                <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                  {/* Left: Avatar + Details */}
                  <div className="flex items-center gap-3.5 min-w-0">
                    <div className="relative shrink-0">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-soft text-sm font-bold text-primary ring-2 ring-surface">
                        {m.name.charAt(0).toUpperCase()}
                      </div>
                      <span className="absolute -bottom-0.5 -right-0.5 ring-2 ring-surface rounded-full">
                        <PresenceDot status={userPresence} size="h-2.5 w-2.5" />
                      </span>
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-bold text-ink truncate">{m.name}</span>
                        <RoleBadge role={m.role} />
                        {m.isOwner && (
                          <span className="rounded-full border border-warning-border bg-warning-soft px-2 py-0.5 text-[10px] font-semibold text-warning">
                            Owner
                          </span>
                        )}
                        {m.userId === meId && (
                          <span className="rounded-full border border-primary-soft-border bg-primary-subtle px-2 py-0.5 text-[10px] font-semibold text-primary">
                            You
                          </span>
                        )}
                        {m.status && <StatusBadge status={m.status} />}
                      </div>

                      <div className="mt-1 flex items-center gap-2 text-xs text-muted flex-wrap">
                        {m.email && <span className="truncate">{m.email}</span>}
                        {m.email && <span className="text-faint">·</span>}
                        
                      </div>
                    </div>
                  </div>

                  {/* Right: Presence Info + Role Selector + Actions */}
                  <div className="flex flex-wrap items-center gap-2.5 sm:justify-end">
                    {/* Live Presence indicator label */}
                    <div className="hidden sm:flex items-center gap-1.5 text-xs text-muted pr-2 border-r border-line-soft">
                      <PresenceDot status={userPresence} />
                      <span className="capitalize">{userPresence}</span>
                    </div>

                    {admin ? (
                      <>
                        {/* Role Select Dropdown */}
                        <div className="relative">
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
                            title={
                              locked
                                ? m.isOwner
                                  ? "The workspace owner's role can't be changed"
                                  : "You can't change your own role"
                                : undefined
                            }
                            className="rounded-xl border border-line bg-surface py-1.5 pl-2.5 pr-8 text-xs font-medium text-body hover:bg-surface-muted disabled:opacity-50"
                          >
                            {ASSIGNABLE_ROLES.map((r) => (
                              <option key={r} value={r}>
                                {ROLE_STYLES[r].label}
                              </option>
                            ))}
                          </select>
                        </div>

                        {/* Edit Button */}
                        {(!m.isOwner || m.userId === meId) && (
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => {
                              setError('');
                              setShowEditPassword(false);
                              setEditing(isEditing ? null : m.userId);
                            }}
                            className={`rounded-xl border px-3 py-1.5 text-xs font-medium transition ${
                              isEditing
                                ? 'border-primary bg-primary-subtle text-primary'
                                : 'border-line text-body hover:bg-surface-muted'
                            } disabled:opacity-40`}
                          >
                            {isEditing ? 'Close' : 'Edit'}
                          </button>
                        )}

                        {/* Active Toggle Switch */}
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
                                  : "They are signed out immediately and can't sign in to this workspace until you activate them again. Their chat history stays intact.",
                                yes: next ? 'Yes, activate' : 'Yes, deactivate',
                                danger: !next,
                                run: async () => {
                                  await setMemberActive(m.userId, next);
                                  setNotice(
                                    next
                                      ? `${m.name} is active again and can sign in.`
                                      : `${m.name} was deactivated and signed out.`,
                                  );
                                  load();
                                },
                              })
                            }
                          />
                        )}

                        {/* Remove Button */}
                        <button
                          type="button"
                          disabled={locked || busy !== null}
                          onClick={() => {
                            setPending({
                              title: `Remove ${m.name} from this workspace?`,
                              body: "They lose access immediately and their chats return to New Leads. Their account isn't deleted.",
                              yes: 'Yes, remove',
                              danger: true,
                              run: async () => {
                                await removeMember(m.userId);
                                setNotice(`${m.name} was removed from this workspace.`);
                                load();
                              },
                            });
                          }}
                          title={locked ? "Cannot remove owner or yourself" : "Remove member"}
                          className="rounded-xl px-2.5 py-1.5 text-xs font-semibold text-danger hover:bg-danger-soft disabled:opacity-30 disabled:hover:bg-transparent"
                        >
                          Remove
                        </button>
                      </>
                    ) : (
                      <span className="text-xs font-medium text-muted">View Only</span>
                    )}
                  </div>
                </div>

                {/* Inline Edit Form Panel */}
                {admin && isEditing && (
                  <div className="border-t border-line-soft bg-surface-muted/60 p-4 sm:p-5">
                    <form onSubmit={(e) => onEdit(e, m)} className="max-w-xl space-y-3.5">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-bold text-ink">Edit Details for {m.name}</h4>
                        <span className="text-[11px] text-faint">User ID: {m.userId}</span>
                      </div>

                      <div>
                        <label className="block text-[11px] font-semibold text-muted uppercase tracking-wider mb-1">
                          Full Name
                        </label>
                        <input
                          name="name"
                          defaultValue={m.name}
                          required
                          maxLength={191}
                          placeholder="Name"
                          aria-label={`Name for ${m.name}`}
                          className={inputClass}
                        />
                      </div>

                      {m.userId !== meId ? (
                        <div>
                          <label className="block text-[11px] font-semibold text-muted uppercase tracking-wider mb-1">
                            New Password (Optional)
                          </label>
                          <PasswordPair
                            show={showEditPassword}
                            onToggle={() => setShowEditPassword((v) => !v)}
                            idPrefix={`edit-${m.userId}`}
                            label="New password"
                          />
                          <p className="mt-1 text-[11px] text-muted">
                            Leave blank to keep their current password. Setting a new one signs them out everywhere; only a hash is stored.
                          </p>
                        </div>
                      ) : (
                        <p className="rounded-xl border border-line bg-surface p-3 text-xs text-muted">
                          To change your own password, visit <strong className="font-semibold text-ink">My account</strong> or use "Forgot password" on the sign-in screen.
                        </p>
                      )}

                      <div className="flex items-center gap-2 pt-1">
                        <button disabled={busy !== null} className={`${buttonClass} w-auto px-4 py-2`}>
                          {busy === `edit:${m.userId}` ? 'Saving…' : 'Save changes'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing(null)}
                          className="rounded-xl border border-line bg-surface px-4 py-2 text-xs font-semibold text-body hover:bg-surface-muted"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Add a Person Card (Admins only) */}
      {admin && (
        <section id="add-person" className="rounded-2xl border border-line bg-surface p-5 sm:p-6 shadow-xs">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary-soft text-primary shadow-2xs">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <line x1="19" y1="8" x2="19" y2="14" />
                  <line x1="22" y1="11" x2="16" y2="11" />
                </svg>
              </span>
              <div>
                <h3 className="text-sm font-bold text-ink">Add a Person</h3>
                <p className="text-xs text-muted">Invite a teammate with their email and role</p>
              </div>
            </div>

            <form onSubmit={onInvite} className="mt-5 space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label className="block text-[11px] font-semibold text-muted uppercase tracking-wider mb-1">
                    Name <span className="text-danger">*</span>
                  </label>
                  <input name="name" required maxLength={191} placeholder="Full Name" className={inputClass} />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-muted uppercase tracking-wider mb-1">
                    Email <span className="text-danger">*</span>
                  </label>
                  <input name="email" required type="email" placeholder="name@company.com" className={inputClass} />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-muted uppercase tracking-wider mb-1">
                    Assign Role <span className="text-danger">*</span>
                  </label>
                  <select name="role" defaultValue="agent" aria-label="Role" className={inputClass}>
                    {ASSIGNABLE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_STYLES[r].label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Password credentials block */}
              <div className="rounded-xl border border-line bg-surface-muted/50 p-4 space-y-2.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-ink">Password <span className="text-danger">*</span> </label>
                  <button
                    type="button"
                    onClick={() => {
                      const val = suggestPassword();
                      setGeneratedPassword(val);
                      for (const id of ['new-password', 'new-confirm']) {
                        const el = document.getElementById(id) as HTMLInputElement | null;
                        if (el) el.value = val;
                      }
                      if (!showPassword) setShowPassword(true);
                    }}
                    className="text-[11px] font-medium text-primary hover:text-primary-hover hover:underline"
                  >
                    Suggest strong password
                  </button>
                </div>

                <PasswordPair
                  key={generatedPassword}
                  show={showPassword}
                  onToggle={() => setShowPassword((v) => !v)}
                  idPrefix="new"
                  label="Password"
                  defaultValue={generatedPassword}
                />

                <p className="text-[11px] text-muted leading-relaxed">
                  A new password is generated for each person and emailed to them with the login link. Teammates can change it under{' '}
                  <span className="font-semibold text-ink">My account</span>. Clear the password to send an invite email instead.
                </p>
              </div>

              <div className="flex justify-end pt-1">
                <button disabled={busy !== null} className={`${buttonClass} w-full sm:w-auto px-6 py-2.5`}>
                  {busy === 'invite' ? (
                    <span className="inline-flex items-center gap-2">
                      <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Adding member…
                    </span>
                  ) : (
                    'Add to team'
                  )}
                </button>
              </div>
            </form>
          </section>
      )}

      {/* Confirmation Dialog */}
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
    </div>
  );
}

// active: can sign in · invited: hasn't chosen a password from the invite email yet · inactive: deactivated here
function StatusBadge({ status }: { status: string }) {
  const look =
    status === 'invited'
      ? {
          label: 'Invited',
          title: 'Added by an admin; waiting for them to choose a password from the invite email',
          className: 'bg-warning-soft text-warning border border-warning-border/60',
        }
      : status === 'inactive'
        ? {
            label: 'Inactive',
            title: "Deactivated by an admin: can't sign in to this workspace until reactivated",
            className: 'bg-surface-strong text-muted border border-line',
          }
        : {
            label: 'Active',
            title: 'Can sign in',
            className: 'bg-success-soft text-success border border-success/30',
          };
  return (
    <span
      title={look.title}
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${look.className}`}
    >
      {look.label}
    </span>
  );
}

// Password + Confirm password with one show/hide toggle and a Suggest button
function PasswordPair({
  show,
  onToggle,
  idPrefix,
  label,
  defaultValue,
}: {
  show: boolean;
  onToggle: () => void;
  idPrefix: string;
  label: string;
  defaultValue?: string;
}) {
  const type = show ? 'text' : 'password';

  return (
    <div className="grid gap-2.5 sm:grid-cols-2">
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
function ActiveToggle({
  name,
  active,
  disabled,
  onChange,
}: {
  name: string;
  active: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      aria-label={`${name} is ${active ? 'active' : 'inactive'}; click to ${active ? 'deactivate' : 'activate'}`}
      title={
        active
          ? "Deactivate: they can't sign in here until reactivated; nothing is deleted"
          : 'Activate: they can sign in to this workspace again'
      }
      disabled={disabled}
      onClick={() => onChange(!active)}
      className="flex items-center gap-2 rounded-xl border border-line px-2.5 py-1 text-[11px] font-medium text-body hover:bg-surface-muted disabled:opacity-40"
    >
      <span
        className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
          active ? 'bg-success' : 'bg-line-strong'
        }`}
      >
        <span
          className={`inline-block h-3 w-3 rounded-full bg-surface shadow-xs transition-transform ${
            active ? 'translate-x-3.5' : 'translate-x-0.5'
          }`}
        />
      </span>
      <span>{active ? 'Active' : 'Inactive'}</span>
    </button>
  );
}
