'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { getToken, setToken } from '@/lib/api';
import { type WorkspaceSummary, createWorkspace, fetchMe, fetchWorkspaces, switchWorkspace } from '@/lib/auth';

export type Me = {
  user: { id: string; name: string; email: string };
  workspace: { id: string; name: string; whatsapp: { displayPhone: string | null; phoneNumberId?: string; wabaId?: string } | null };
};

// Slim Left Icon Rail + Full App Shell
export function AppShell({
  children,
}: {
  children: (me: Me) => React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [automationMenuOpen, setAutomationMenuOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [newWorkspace, setNewWorkspace] = useState('');
  // The name field only appears after clicking "Create workspace"
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState('');

  // Load the user's workspaces when the switcher opens
  useEffect(() => {
    if (!workspaceMenuOpen) {
      setCreatingWorkspace(false);
      setNewWorkspace('');
      return;
    }
    setWorkspaceError('');
    fetchWorkspaces()
      .then(setWorkspaces)
      .catch((err) => setWorkspaceError((err as Error).message));
  }, [workspaceMenuOpen]);

  // Creating or switching gives a token for that workspace; reload so the inbox, sockets and data all follow it
  async function enterWorkspace(request: () => Promise<{ token: string }>) {
    setWorkspaceBusy(true);
    setWorkspaceError('');
    try {
      const { token } = await request();
      setToken(token);
      window.location.assign('/inbox');
    } catch (err) {
      setWorkspaceError((err as Error).message);
      setWorkspaceBusy(false);
    }
  }

  const userMenuRef = useRef<HTMLDivElement>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const automationMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
      if (workspaceMenuRef.current && !workspaceMenuRef.current.contains(e.target as Node)) {
        setWorkspaceMenuOpen(false);
      }
      if (automationMenuRef.current && !automationMenuRef.current.contains(e.target as Node)) {
        setAutomationMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    fetchMe<Me>()
      .then(setMe)
      .catch(() => {
        router.replace('/login');
      });
  }, [router]);

  if (!me) {
    return (
      <div className="grid h-screen place-items-center bg-page text-sm text-muted font-medium">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-3 border-primary border-t-transparent" />
          <span>Loading support-tyrescart...</span>
        </div>
      </div>
    );
  }

  const isConnected = !!me.workspace.whatsapp?.displayPhone;
  const userInitial = (me.user.name || me.user.email || 'U').charAt(0).toUpperCase();
  const workspaceInitial = (me.workspace.name || 'W').charAt(0).toUpperCase();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-shell font-sans antialiased text-ink-soft">
      {/* 1. Expandable / Collapsible Left Sidebar */}
      <aside
        className={`relative flex shrink-0 flex-col justify-between border-r border-line/80 bg-surface z-30 transition-all duration-200 ease-in-out ${
          sidebarOpen ? 'w-60' : 'w-14'
        }`}
      >
        {sidebarOpen ? (
          /* EXPANDED SIDEBAR */
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Top Logo & Collapse Toggle */}
            <div className="flex h-16 items-center justify-between px-4 border-b border-line-soft">
              <div className="flex items-center gap-2">
                <span className="text-base font-extrabold tracking-tight text-ink flex items-center gap-1">
                  support-tyrescart
                  <span className="h-2 w-2 rounded-full bg-accent inline-block" />
                </span>
              </div>
              <button
                onClick={() => setSidebarOpen(false)}
                title="Collapse sidebar"
                className="flex h-7 w-7 items-center justify-center rounded-lg text-faint hover:bg-surface-strong hover:text-body transition cursor-pointer"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m11 17-5-5 5-5" />
                  <path d="m18 17-5-5 5-5" />
                </svg>
              </button>
            </div>

            {/* Search Input Box */}
            <div className="p-3">
              <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-muted/60 px-3 py-1.5 text-xs text-ink-soft">
                <svg className="h-3.5 w-3.5 text-faint shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <input
                  type="text"
                  placeholder="Search menu..."
                  className="w-full bg-transparent text-xs text-ink placeholder:text-faint outline-none"
                />
                <span className="flex items-center gap-0.5 rounded border border-line bg-surface px-1 py-0.5 text-[9px] font-semibold text-faint">
                  ⌘K
                </span>
              </div>
            </div>

            {/* Navigation Menus */}
            <div className="flex-1 overflow-y-auto px-3 py-2 space-y-4 text-xs">
              {/* Active Menu: CONVERSATIONS */}
              <div>
                <p className="px-2 pb-1.5 text-[10px] font-bold tracking-wider text-faint uppercase">
                  CONVERSATIONS
                </p>
                <div className="space-y-0.5">
                  <Link
                    href="/inbox"
                    className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs font-semibold transition ${
                      pathname === '/inbox'
                        ? 'bg-secondary text-on-primary shadow-2xs'
                        : 'text-body hover:bg-surface-strong'
                    }`}
                  >
                    <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect width="20" height="16" x="2" y="4" rx="2" />
                      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                    </svg>
                    <span>Inbox</span>
                  </Link>

                  {/* Future Contacts / Leads menus
                  <button
                    onClick={() => router.push('/inbox')}
                    className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs font-medium text-body hover:bg-surface-strong transition cursor-pointer"
                  >
                    <svg className="h-4 w-4 text-faint shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                    <span>Contacts</span>
                  </button>

                  <button
                    onClick={() => router.push('/inbox')}
                    className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs font-medium text-body hover:bg-surface-strong transition cursor-pointer"
                  >
                    <svg className="h-4 w-4 text-faint shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                      <line x1="4" y1="22" x2="4" y2="15" />
                    </svg>
                    <span>Leads</span>
                  </button>
                  */}
                </div>
              </div>

              {/* HOME SECTION (Hidden for now)
              <div>
                <p className="px-2 pb-1.5 text-[10px] font-bold tracking-wider text-faint uppercase">
                  HOME
                </p>
                <div className="space-y-0.5">
                  <button
                    onClick={() => router.push('/inbox')}
                    className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs font-medium text-body hover:bg-surface-strong transition cursor-pointer"
                  >
                    <svg className="h-4 w-4 text-faint shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect width="7" height="7" x="3" y="3" rx="1" />
                      <rect width="7" height="7" x="14" y="3" rx="1" />
                      <rect width="7" height="7" x="14" y="14" rx="1" />
                      <rect width="7" height="7" x="3" y="14" rx="1" />
                    </svg>
                    <span>Overview</span>
                  </button>
                  <div className="flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-xs font-medium text-faint cursor-not-allowed">
                    <div className="flex items-center gap-2.5">
                      <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 3v18h18" />
                        <path d="m19 9-5 5-4-4-3 3" />
                      </svg>
                      <span>Analytics</span>
                    </div>
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  </div>
                  <div className="flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-xs font-medium text-faint cursor-not-allowed">
                    <div className="flex items-center gap-2.5">
                      <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                        <circle cx="9" cy="7" r="4" />
                        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                      </svg>
                      <span>Team</span>
                    </div>
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  </div>
                </div>
              </div>
              */}

              {/* OUTREACH SECTION (Hidden for now)
              <div>
                <p className="px-2 pb-1.5 text-[10px] font-bold tracking-wider text-faint uppercase">
                  OUTREACH
                </p>
                <div className="space-y-0.5">
                  <button
                    onClick={() => router.push('/settings')}
                    className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs font-medium text-body hover:bg-surface-strong transition cursor-pointer"
                  >
                    <svg className="h-4 w-4 text-faint shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span>Templates</span>
                  </button>
                  <button
                    onClick={() => alert('Campaigns manager')}
                    className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs font-medium text-body hover:bg-surface-strong transition cursor-pointer"
                  >
                    <svg className="h-4 w-4 text-faint shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m3 11 18-5v12L3 13v-2z" />
                      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
                    </svg>
                    <span>Campaigns</span>
                  </button>
                  <button
                    onClick={() => router.push('/settings')}
                    className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs font-medium text-body hover:bg-surface-strong transition cursor-pointer"
                  >
                    <svg className="h-4 w-4 text-faint shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48 2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48 2.83-2.83" />
                    </svg>
                    <span>Integrations</span>
                  </button>
                </div>
              </div>
              */}

              {/* DEVELOPER SECTION (Hidden for now)
              <div>
                <p className="px-2 pb-1.5 text-[10px] font-bold tracking-wider text-faint uppercase">
                  DEVELOPER
                </p>
                <div className="space-y-0.5">
                  <div className="flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-xs font-medium text-faint cursor-not-allowed">
                    <div className="flex items-center gap-2.5">
                      <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="16 18 22 12 16 6" />
                        <polyline points="8 6 2 12 8 18" />
                      </svg>
                      <span>Developer API</span>
                    </div>
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  </div>
                </div>
              </div>
              */}
            </div>

            {/* Bottom Upgrade Pill Card (Hidden for now)
            <div className="p-3 border-t border-line-soft">
              <button
                onClick={() => alert('Upgrade to TyresCart Pro')}
                className="flex w-full items-center justify-between rounded-2xl bg-primary-dark p-2 text-xs font-semibold text-on-primary shadow-sm hover:opacity-95 transition cursor-pointer"
              >
                <div className="flex items-center gap-2.5">
                  <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-primary-soft text-primary text-xs font-bold">
                    ✨
                  </span>
                  <span className="font-semibold text-white">Upgrade</span>
                </div>
                <svg className="h-4 w-4 text-white/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </button>
            </div>
            */}
          </div>
        ) : (
          /* COLLAPSED SLIM ICON RAIL */
          <div className="flex flex-1 flex-col items-center justify-between py-3">
            <div className="flex flex-col items-center gap-4 w-full">
              {/* Expand Chevron Button */}
              <button
                onClick={() => setSidebarOpen(true)}
                title="Expand sidebar"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-faint hover:bg-surface-strong hover:text-body transition cursor-pointer"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m6 17 5-5-5-5" />
                  <path d="m13 17 5-5-5-5" />
                </svg>
              </button>

              {/* Slim Icons */}
              <div className="flex flex-col items-center gap-2 w-full">
                <Link
                  href="/inbox"
                  title="Inbox"
                  className={`flex h-9 w-9 items-center justify-center rounded-xl transition ${
                    pathname === '/inbox'
                      ? 'bg-secondary text-on-primary shadow-2xs'
                      : 'text-faint hover:bg-surface-strong hover:text-body'
                  }`}
                >
                  <svg className="h-4.5 w-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect width="20" height="16" x="2" y="4" rx="2" />
                    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                  </svg>
                </Link>

                {/* Future Slim Icons (Hidden for now)
                <button
                  onClick={() => setSidebarOpen(true)}
                  title="Contacts"
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-faint hover:bg-surface-strong hover:text-body transition"
                >
                  <svg className="h-4.5 w-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                </button>
                <button
                  onClick={() => setSidebarOpen(true)}
                  title="Templates"
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-faint hover:bg-surface-strong hover:text-body transition"
                >
                  <svg className="h-4.5 w-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                </button>
                <button
                  onClick={() => setSidebarOpen(true)}
                  title="Campaigns"
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-faint hover:bg-surface-strong hover:text-body transition"
                >
                  <svg className="h-4.5 w-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m3 11 18-5v12L3 13v-2z" />
                    <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
                  </svg>
                </button>
                */}
              </div>
            </div>

            {/* Bottom Upgrade Icon (Hidden for now)
            <div className="w-full px-2 flex justify-center">
              <button
                onClick={() => setSidebarOpen(true)}
                title="Upgrade"
                className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary-dark text-on-primary shadow-sm hover:opacity-90 transition cursor-pointer"
              >
                <span className="text-xs">✨</span>
              </button>
            </div>
            */}
          </div>
        )}
      </aside>

      {/* 2. Main Content Area (Header + Workspace) */}
      <div className="flex flex-1 flex-col overflow-hidden min-w-0">
        {/* Top Header Bar */}
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-line/80 bg-surface px-6">
          {/* Header Left: Back + Title + Connection Badge + Subtitle */}
          <div className="flex min-w-0 items-center gap-3">
            <button
              onClick={() => router.back()}
              className="flex h-7 w-7 items-center justify-center rounded-md text-faint hover:bg-surface-strong hover:text-body transition"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>

            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold tracking-tight text-ink">Inbox</h1>
                {isConnected ? (
                  <span className="inline-flex shrink-0 items-center whitespace-nowrap gap-1 rounded-full border border-primary-soft-border bg-primary-soft px-2.5 py-0.5 text-[11px] font-semibold text-primary">
                    <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                    Connected: {me.workspace.whatsapp?.displayPhone}
                  </span>
                ) : (
                  <Link
                    href="/settings"
                    className="inline-flex shrink-0 items-center whitespace-nowrap gap-1 rounded-full border border-warning-border bg-warning-soft px-2.5 py-0.5 text-[11px] font-medium text-warning hover:bg-warning-soft-hover transition"
                  >
                    Not connected
                  </Link>
                )}
              </div>
              <p className="truncate text-[11px] text-faint -mt-0.5">Conversations with your customers</p>
            </div>

            {/* Channels Tabs (hidden)
            <div className="ml-6 hidden md:flex items-center gap-5 border-l border-line pl-6 text-xs">
              <button className="flex items-center gap-1.5 font-semibold text-primary border-b-2 border-primary pb-1 pt-1">
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-accent text-on-primary text-[9px]">💬</span>
                WhatsApp
              </button>
              <button className="flex items-center gap-1.5 text-faint hover:text-body transition pb-1 pt-1">
                <span>🎫</span> Tickets
              </button>
              <button className="flex items-center gap-1.5 text-faint hover:text-body transition pb-1 pt-1">
                <span>💬</span> Web chat bot
              </button>
              <button className="flex items-center gap-1.5 text-faint hover:text-body transition pb-1 pt-1">
                <span>👥</span> Team chat
              </button>
            </div>
            */}
          </div>

          {/* Header Right Controls */}
          <div className="flex shrink-0 items-center gap-3 pl-3">
            {/* New Campaign Button */}
            {/* <button
              onClick={() => alert('New Campaign modal / Broadcast wizard')}
              className="flex items-center gap-2 whitespace-nowrap rounded-full bg-secondary px-4 py-1.5 text-xs font-semibold text-on-primary shadow-xs hover:bg-secondary-hover active:scale-[0.98] transition cursor-pointer"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
              <span>New campaign</span>
            </button> */}

            {/* Vertical Separator */}
            {/* <div className="h-5 w-px bg-line" /> */}

            {/* Workspace Switcher */}
            <div ref={workspaceMenuRef} className="relative">
              <button
                onClick={() => setWorkspaceMenuOpen(!workspaceMenuOpen)}
                className="flex items-center gap-2 rounded-full border border-line bg-surface py-1 pl-1.5 pr-3 text-xs text-body shadow-2xs hover:bg-surface-muted transition cursor-pointer"
              >
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-secondary text-[10px] font-bold text-on-primary">
                  {workspaceInitial}
                </span>
                <span className="font-medium max-w-[100px] truncate">{me.workspace.name}</span>
                <svg className="h-3 w-3 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m7 15 5 5 5-5" />
                  <path d="m7 9 5-5 5 5" />
                </svg>
              </button>

              {/* Workspace Popover Dropdown */}
              {workspaceMenuOpen && (
                <div className="absolute right-0 top-11 w-64 rounded-2xl border border-line bg-surface p-3 shadow-xl z-50">
                  <div className="px-1 pb-2 text-[10px] font-bold tracking-wider text-faint uppercase">
                    YOUR WORKSPACES
                  </div>

                  {/* All of the user's workspaces; the active one is ticked, the others switch to it */}
                  <div className="max-h-56 space-y-1 overflow-y-auto">
                    {(workspaces ?? [{ id: me.workspace.id, name: me.workspace.name, role: '' }]).map((w) => {
                      const active = w.id === me.workspace.id;
                      return (
                        <button
                          key={w.id}
                          type="button"
                          disabled={active || workspaceBusy}
                          onClick={() => enterWorkspace(() => switchWorkspace(w.id))}
                          className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-xs font-semibold text-ink transition ${
                            active ? 'bg-primary-soft/80 cursor-default' : 'hover:bg-surface-strong cursor-pointer disabled:opacity-60'
                          }`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-bold text-on-primary">
                              {(w.name || 'W').charAt(0).toUpperCase()}
                            </span>
                            <span className="truncate">{w.name}</span>
                          </div>
                          {active && (
                            <svg className="h-4 w-4 shrink-0 text-ink" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {workspaceError && (
                    <div className="mt-2 rounded-lg bg-danger-soft px-2.5 py-1.5 text-xs text-danger">{workspaceError}</div>
                  )}

                  {/* Add New Workspace: a button first, the name field once it's clicked */}
                  {!creatingWorkspace ? (
                    <button
                      type="button"
                      onClick={() => setCreatingWorkspace(true)}
                      className="mt-3 flex w-full items-center gap-2 rounded-xl border border-dashed border-line-strong px-3 py-2 text-xs font-semibold text-secondary hover:bg-surface-strong transition cursor-pointer"
                    >
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-strong text-sm leading-none">+</span>
                      Create workspace
                    </button>
                  ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!newWorkspace.trim() || workspaceBusy) return;
                      enterWorkspace(() => createWorkspace(newWorkspace.trim()));
                    }}
                    className="mt-3"
                  >
                    <div className="rounded-xl border-2 border-secondary/80 p-0.5 bg-surface">
                      <input
                        type="text"
                        placeholder="Workspace name"
                        autoFocus
                        value={newWorkspace}
                        maxLength={191}
                        onChange={(e) => setNewWorkspace(e.target.value)}
                        className="w-full rounded-lg bg-transparent px-2.5 py-1.5 text-xs text-ink placeholder:text-faint outline-none"
                      />
                    </div>
                    <div className="mt-2.5 flex items-center gap-2">
                      <button
                        type="submit"
                        disabled={!newWorkspace.trim() || workspaceBusy}
                        className="rounded-lg bg-secondary px-3.5 py-1 text-xs font-semibold text-on-primary shadow-2xs hover:bg-secondary-hover disabled:opacity-50 transition cursor-pointer"
                      >
                        {workspaceBusy ? 'Please wait…' : 'Create'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setNewWorkspace('');
                          setCreatingWorkspace(false);
                        }}
                        className="px-2 py-1 text-xs text-muted hover:text-body transition cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                  )}
                </div>
              )}
            </div>

            {/* Round WhatsApp Icon Button */}
            <button
              onClick={() => router.push('/settings')}
              title="WhatsApp Status"
              className="flex h-7.5 w-7.5 items-center justify-center rounded-full bg-accent text-on-primary shadow-2xs hover:scale-105 transition cursor-pointer"
            >
              <svg className="h-4 w-4 fill-on-primary" viewBox="0 0 24 24">
                <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z" />
              </svg>
            </button>

            {/* Page-specific header controls (the inbox renders its Assign dropdown here) */}
            <div id="app-header-actions" className="contents" />

            {/* Automation Menu Button */}
            <div ref={automationMenuRef} className="relative">
              <button
                onClick={() => setAutomationMenuOpen(!automationMenuOpen)}
                className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-muted hover:bg-surface-muted transition cursor-pointer"
              >
                <svg className="h-4 w-4 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect width="16" height="16" x="4" y="4" rx="2" />
                  <rect width="6" height="6" x="9" y="9" rx="1" />
                  <path d="M15 2v2" />
                  <path d="M15 20v2" />
                  <path d="M2 15h2" />
                  <path d="M2 9h2" />
                  <path d="M20 15h2" />
                  <path d="M20 9h2" />
                  <path d="M9 2v2" />
                  <path d="M9 20v2" />
                </svg>
                <svg className="h-3 w-3 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>

              {automationMenuOpen && (
                <div className="absolute right-0 top-11 w-60 rounded-2xl border border-line bg-surface p-2 shadow-xl z-50 overflow-hidden">
                  <div className="px-3 pt-2 pb-1.5 text-xs font-semibold text-muted">
                    Automation
                  </div>

                  <div className="space-y-0.5 text-xs">
                    <button
                      onClick={() => {
                        alert('Bot builder feature');
                        setAutomationMenuOpen(false);
                      }}
                      className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-body hover:bg-surface-strong transition cursor-pointer"
                    >
                      <div className="flex items-center gap-3">
                        <svg className="h-4 w-4 text-faint shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="3" />
                          <path d="M12 2v2" />
                          <path d="M12 20v2" />
                          <path d="m4.93 4.93 1.41 1.41" />
                          <path d="m17.66 17.66 1.41 1.41" />
                          <path d="M2 12h2" />
                          <path d="M20 12h2" />
                          <path d="m6.34 17.66-1.41 1.41" />
                          <path d="m19.07 4.93-1.41 1.41" />
                        </svg>
                        <span>Bot builder</span>
                      </div>
                      <svg className="h-3.5 w-3.5 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                    </button>

                    <button
                      onClick={() => {
                        alert('WhatsApp Flows manager');
                        setAutomationMenuOpen(false);
                      }}
                      className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-body hover:bg-surface-strong transition cursor-pointer"
                    >
                      <div className="flex items-center gap-3">
                        <svg className="h-4 w-4 text-faint shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                        </svg>
                        <span>WhatsApp Flows</span>
                      </div>
                    </button>

                    <button
                      onClick={() => {
                        alert('Knowledge base AI');
                        setAutomationMenuOpen(false);
                      }}
                      className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-body hover:bg-surface-strong transition cursor-pointer"
                    >
                      <div className="flex items-center gap-3">
                        <svg className="h-4 w-4 text-faint shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                        </svg>
                        <span>Knowledge base</span>
                      </div>
                      <svg className="h-3.5 w-3.5 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                    </button>

                    <button
                      onClick={() => {
                        alert('Decision bot builder');
                        setAutomationMenuOpen(false);
                      }}
                      className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-body hover:bg-surface-strong transition cursor-pointer"
                    >
                      <div className="flex items-center gap-3">
                        <svg className="h-4 w-4 text-faint shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="18" cy="5" r="3" />
                          <circle cx="6" cy="12" r="3" />
                          <circle cx="18" cy="19" r="3" />
                          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                        </svg>
                        <span>Decision bot</span>
                      </div>
                      <svg className="h-3.5 w-3.5 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                    </button>

                    <button
                      onClick={() => {
                        alert('Q&A bot builder');
                        setAutomationMenuOpen(false);
                      }}
                      className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-body hover:bg-surface-strong transition cursor-pointer"
                    >
                      <div className="flex items-center gap-3">
                        <svg className="h-4 w-4 text-faint shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="10" />
                          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                          <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                        <span>Q&A bot</span>
                      </div>
                      <svg className="h-3.5 w-3.5 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Settings Gear Button */}
            <Link
              href="/settings"
              title="Settings"
              className="flex h-7.5 w-7.5 items-center justify-center rounded-full border border-line text-muted hover:bg-surface-muted transition"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </Link>

            {/* Vertical Separator */}
            <div className="h-5 w-px bg-line" />

            {/* User Profile Dropdown */}
            <div ref={userMenuRef} className="relative">
              <button
                onClick={() => setUserMenuOpen(!userMenuOpen)}
                className="flex items-center gap-2 rounded-full border border-line bg-surface py-1 pl-1.5 pr-3 text-xs text-body shadow-2xs hover:bg-surface-muted transition cursor-pointer"
              >
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-secondary text-[10px] font-bold text-on-primary">
                  {userInitial}
                </span>
                <span className="font-semibold max-w-[120px] truncate">{me.user.name || me.user.email}</span>
                <svg className="h-3 w-3 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>

              {userMenuOpen && (
                <div className="absolute right-0 top-11 w-64 rounded-2xl border border-line bg-surface shadow-xl z-50 overflow-hidden">
                  {/* User Profile Header Card */}
                  <div className="flex items-center gap-3 px-4 py-3.5 border-b border-line-soft">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-bold text-on-primary">
                      {userInitial}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-bold text-ink truncate">{me.user.name || 'User'}</p>
                      <p className="text-[11px] text-muted truncate">{me.user.email}</p>
                    </div>
                  </div>

                  {/* Section Title */}
                  <div className="px-4 pt-3 pb-1 text-[11px] font-semibold text-muted">
                    Workspace settings
                  </div>

                  {/* Settings Menu List */}
                  <div className="p-1 space-y-0.5 text-xs">
                    <Link
                      href="/settings"
                      onClick={() => setUserMenuOpen(false)}
                      className="flex items-center gap-3 rounded-xl px-3 py-2 text-body hover:bg-surface-strong transition"
                    >
                      <svg className="h-4 w-4 text-faint shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
                        <line x1="12" y1="18" x2="12.01" y2="18" />
                      </svg>
                      <span>WhatsApp</span>
                    </Link>

                    <button
                      onClick={() => {
                        alert('SLA policies settings');
                        setUserMenuOpen(false);
                      }}
                      className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-body hover:bg-surface-strong transition cursor-pointer"
                    >
                      <svg className="h-4 w-4 text-faint shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                      </svg>
                      <span>SLA policies</span>
                    </button>

                    <button
                      onClick={() => {
                        alert('Audit & Webhook Logs');
                        setUserMenuOpen(false);
                      }}
                      className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-body hover:bg-surface-strong transition cursor-pointer"
                    >
                      <svg className="h-4 w-4 text-faint shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="8" y1="6" x2="21" y2="6" />
                        <line x1="8" y1="12" x2="21" y2="12" />
                        <line x1="8" y1="18" x2="21" y2="18" />
                        <line x1="3" y1="6" x2="3.01" y2="6" />
                        <line x1="3" y1="12" x2="3.01" y2="12" />
                        <line x1="3" y1="18" x2="3.01" y2="18" />
                      </svg>
                      <span>Logs</span>
                    </button>

                    <button
                      onClick={() => {
                        alert('Billing & Subscription');
                        setUserMenuOpen(false);
                      }}
                      className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-body hover:bg-surface-strong transition cursor-pointer"
                    >
                      <svg className="h-4 w-4 text-faint shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect width="20" height="14" x="2" y="5" rx="2" />
                        <line x1="2" y1="10" x2="22" y2="10" />
                      </svg>
                      <span>Billing</span>
                    </button>
                  </div>

                  {/* Sign Out Action */}
                  <div className="border-t border-line-soft p-1">
                    <button
                      onClick={() => {
                        setToken(null);
                        router.replace('/login');
                      }}
                      className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-xs font-medium text-danger hover:bg-danger-soft transition cursor-pointer"
                    >
                      <svg className="h-4 w-4 text-danger shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                        <polyline points="16 17 21 12 16 7" />
                        <line x1="21" y1="12" x2="9" y2="12" />
                      </svg>
                      <span>Sign out</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Dynamic Children (Inbox, Settings, etc.) */}
        <main className="flex-1 min-h-0 overflow-hidden">{children(me)}</main>
      </div>
    </div>
  );
}

