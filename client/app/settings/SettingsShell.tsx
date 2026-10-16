'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLayoutEffect, useRef, useState } from 'react';
import { isAdminRole } from '@/lib/roles';
import { type Me, settingsReturnPath } from '../AppShell';

type Item = { href: string; label: string };
type Group = { key: string; title: string; items: Item[] };

// Settings menu: what each person can open. Workspace pages (company, users, roles, reports) are for owners/admins.
export function settingsGroups(role: string | undefined): Group[] {
  const admin = isAdminRole(role);
  return [
    { key: 'you', title: 'Your preferences', items: [{ href: '/settings', label: 'General' }, { href: '/settings/whatsapp-qr', label: 'WhatsApp QR code' }] },
    { key: 'inbox', title: 'Inbox settings', items: [{ href: '/settings/saved-replies', label: 'Saved replies' }] },
    ...(admin
      ? [
          {
            key: 'company',
            title: 'Company settings',
            items: [
              { href: '/settings/company', label: 'Company details' },
              { href: '/settings/workspace', label: 'Workspace preferences' },
              // Inside Settings (the same pages as /teams and /reports), so the menu stays put
              { href: '/settings/users', label: 'User management' },
              { href: '/settings/roles', label: 'Roles and permissions' },
              { href: '/settings/reports', label: 'Reports' },
            ],
          },
        ]
      : []),
    {
      key: 'data',
      title: 'Contacts and data',
      items: [
        { href: '/settings/labels', label: 'Labels' },
        { href: '/settings/contact-properties', label: 'Contact properties' },
        { href: '/settings/lifecycle', label: 'Customer lifecycle' },
        // Restoring deleted contacts is for owners/admins (they delete them)
        ...(admin ? [{ href: '/settings/deleted-contacts', label: 'Recently deleted contacts' }] : []),
      ],
    },
  ];
}

const KEY = 'support:settingsMenu';
type MenuState = { hidden: boolean; closed: string[] };
// Each Settings page mounts its own shell: the menu's state and scroll position are kept here between pages, so
// moving from one page to another doesn't make the menu jump (folded groups flashing open, scrolling to the top)
let remembered: MenuState | null = null;
let menuScrollTop = 0;
function readState(): MenuState {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { hidden: !!v.hidden, closed: Array.isArray(v.closed) ? v.closed : [] };
  } catch {
    return { hidden: false, closed: [] };
  }
}

// Full-page Settings: "Back to app", the grouped menu (each group folds; the whole menu can be hidden), then the
// page with its section and title on top
export function SettingsShell({ me, section, title, actions, children }: { me: Me; section: string; title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  const pathname = usePathname();
  // The shell only renders in the browser (after sign-in), so the saved state can be used from the first paint
  const [hidden, setHidden] = useState(() => (remembered ??= readState()).hidden);
  const [closed, setClosed] = useState<string[]>(() => (remembered ??= readState()).closed);
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (menuRef.current) menuRef.current.scrollTop = menuScrollTop;
  }, [hidden]);
  const save = (next: MenuState) => {
    remembered = next;
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // private mode: just not remembered
    }
  };
  const toggleMenu = () => {
    setHidden(!hidden);
    save({ hidden: !hidden, closed });
  };
  const toggleGroup = (key: string) => {
    const next = closed.includes(key) ? closed.filter((k) => k !== key) : [...closed, key];
    setClosed(next);
    save({ hidden, closed: next });
  };
  const panelIcon = (
    <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </svg>
  );

  return (
    <div className="flex h-full overflow-hidden bg-page">
      {!hidden && (
        <nav aria-label="Settings" className="flex w-64 shrink-0 flex-col border-r border-line/90 bg-surface">
          <div className="px-5 pb-3 pt-5">
            <div className="flex items-center justify-between">
              <Link href={settingsReturnPath()} className="flex items-center gap-1.5 text-[13px] font-semibold text-primary hover:underline">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
                Back to app
              </Link>
              <button type="button" onClick={toggleMenu} title="Hide menu" aria-label="Hide settings menu" className="rounded-md p-1 text-body-soft hover:bg-surface-muted">
                {panelIcon}
              </button>
            </div>
            <h1 className="mt-4 text-2xl font-bold tracking-tight text-ink">Settings</h1>
          </div>
          <div
            ref={menuRef}
            onScroll={(e) => (menuScrollTop = e.currentTarget.scrollTop)}
            className="min-h-0 flex-1 overflow-y-auto px-3 pb-6"
            style={{ scrollbarGutter: 'stable' }}
          >
            {settingsGroups(me.role).map((g) => {
              const open = !closed.includes(g.key);
              return (
                <div key={g.key} className="border-t border-line-soft py-2 first:border-t-0">
                  <button
                    type="button"
                    onClick={() => toggleGroup(g.key)}
                    aria-expanded={open}
                    className="flex w-full items-center justify-between rounded-md px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-body"
                  >
                    {g.title}
                    <svg className={`h-4 w-4 transition-transform ${open ? '' : 'rotate-180'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m18 15-6-6-6 6" />
                    </svg>
                  </button>
                  {open && (
                    <ul className="space-y-0.5 pb-1">
                      {g.items.map((it) => {
                        const active = pathname === it.href;
                        return (
                          <li key={it.href}>
                            <Link
                              href={it.href}
                              aria-current={active ? 'page' : undefined}
                              className={`block rounded-lg px-2 py-2 text-[13px] transition ${active ? 'bg-surface-muted font-semibold text-ink shadow-2xs' : 'text-body hover:bg-surface-muted'}`}
                            >
                              {it.label}
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </nav>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-3 border-b border-line/90 bg-surface px-6 py-3.5">
          {hidden && (
            <button type="button" onClick={toggleMenu} title="Show menu" aria-label="Show settings menu" className="rounded-md p-1 text-body-soft hover:bg-surface-muted">
              {panelIcon}
            </button>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">{section}</p>
            <h2 className="truncate text-lg font-bold tracking-tight text-ink">{title}</h2>
          </div>
          {actions}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6" style={{ scrollbarGutter: 'stable' }}>
          {children}
        </div>
      </div>
    </div>
  );
}
