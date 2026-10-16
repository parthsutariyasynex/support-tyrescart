'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import type { Activity } from '@/lib/activity';
import { API_URL, getToken } from '@/lib/api';
import {
  ACTIVITY_FILTERS,
  type ChatDetails,
  type ContactFieldOptions,
  type ContactProfile,
  type ContactRemark,
  activityCard,
  activityKind,
  fetchContactActivity,
  fetchChatDetails,
  fetchContact,
  fetchContactFieldOptions,
  fetchRemarks,
  groupByMonth,
  joinedText,
  profileName,
  timeAgo,
  updateContact,
  nextStage,
  CUSTOM_PROPERTIES_EVENT,
  stagesChanged,
  deleteContact,
} from '@/lib/contacts';
import { useStagesChanged } from '../../inbox/StageMenu';
import { type Conversation, fetchConversation } from '@/lib/inbox';
import { type Label, type Permissions, fetchLabels, fetchPermissions } from '@/lib/labels';
import { formatDateTime } from '@/lib/time';
import { showToast } from '@/lib/toasts';
import { AppShell } from '../../AppShell';
import { ConfirmDialog } from '../../ConfirmDialog';
import { CONTACT_LISTS_EVENT, CONTACT_REMARKS_EVENT, CONTACT_UPDATED_EVENT, PlusIcon, Properties, Remarks, iconButton } from '../../inbox/ContactPanel';
import { LabelPill, LabelsDropdown } from '../../inbox/LabelsDropdown';
import { LabelPicker } from '../../inbox/labels';
import { CONTACT_LIST_DELETED_EVENT, CONTACT_LIST_SAVED_EVENT, ListsDropdown } from '../../inbox/ListsDropdown';
import { MediaTab } from './MediaTab';

// "View contact details": the full page for one customer (from the profile panel's open icon).
// Left: who, lead stage, activity facts, contact info, Contact property. Middle: Activity log, Associations (their
// chat), Remarks, Media. Right: Labels and Lists. Every member can view and edit, like the panel.
export default function ContactDetailsPage() {
  return <AppShell>{() => <ContactDetails />}</AppShell>;
}

type Tab = 'activity' | 'associations' | 'remarks' | 'media';
const TABS: { key: Tab; label: string }[] = [
  { key: 'activity', label: 'Activity log' },
  { key: 'associations', label: 'Associations' },
  { key: 'remarks', label: 'Remarks' },
  { key: 'media', label: 'Media' },
];

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex flex-col items-center px-6 py-6 text-center">
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-strong text-body-soft">
        <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5" />
          <circle cx="11.5" cy="14.5" r="2.5" />
          <path d="m13.5 16.5 2 2" />
        </svg>
      </span>
      <p className="mt-2.5 text-[13px] font-bold text-ink">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted">{text}</p>
    </div>
  );
}

function ContactDetails() {
  const router = useRouter();
  const contactId = String(useParams<{ id: string }>().id ?? '');
  const [contact, setContact] = useState<ContactProfile | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [options, setOptions] = useState<ContactFieldOptions | null>(null);
  // Stages edited in Settings → Customer lifecycle; a deleted stage moved this customer
  useStagesChanged(({ moved }) => {
    fetchContactFieldOptions(true).then(setOptions).catch(() => {});
    if (moved) setContact((prev) => (prev && prev.leadStage === moved.from ? { ...prev, leadStage: moved.to } : prev));
  });
  const [remarks, setRemarks] = useState<ContactRemark[] | null>(null);
  const [activity, setActivity] = useState<Activity[] | null>(null);
  const [labels, setLabels] = useState<Label[]>([]);
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('activity');
  // Opened from the chat's profile panel with ?tab=media&type=document (Attachments → Media / Document)
  const [mediaType, setMediaType] = useState('all');
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get('tab');
    if (t && TABS.some((x) => x.key === t)) setTab(t as Tab);
    const type = q.get('type');
    if (type) setMediaType(type);
  }, [contactId]);
  const [filter, setFilter] = useState<string>('user');
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [listsOpen, setListsOpen] = useState(false);
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const labelsButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const conversationId = contact?.conversationId ?? null;
  const [chat, setChat] = useState<ChatDetails | null>(null);
  const loadConversation = useCallback(() => {
    if (!conversationId) return;
    fetchConversation(conversationId).then(setConversation).catch(() => {});
    fetchChatDetails(conversationId).then(setChat).catch(() => {});
  }, [conversationId]);
  const loadActivity = useCallback(() => {
    fetchContactActivity(contactId)
      .then(setActivity)
      .catch(() => setActivity([]));
  }, [contactId]);
  useEffect(() => loadActivity(), [loadActivity]);

  // Load everything for this customer
  useEffect(() => {
    let cancelled = false;
    setError('');
    fetchContact(contactId)
      .then((c) => !cancelled && setContact(c))
      .catch((e) => !cancelled && setError((e as Error).message));
    fetchRemarks(contactId)
      .then((r) => !cancelled && setRemarks(r))
      .catch(() => !cancelled && setRemarks([]));
    fetchContactFieldOptions().then((o) => !cancelled && setOptions(o)).catch(() => {});
    fetchLabels().then((l) => !cancelled && setLabels(l)).catch(() => {});
    fetchPermissions().then((p) => !cancelled && setPermissions(p)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [contactId]);
  useEffect(() => {
    if (conversationId) loadConversation();
  }, [conversationId, loadConversation]);

  // Live (one connection): the same customer events the chat side panel follows, plus this chat's labels, assignee,
  // status and history
  useEffect(() => {
    const socket = io(API_URL, { auth: { token: getToken() } });
    const relay = (event: string, windowEvent: string) => socket.on(event, (d: unknown) => window.dispatchEvent(new CustomEvent(windowEvent, { detail: d })));
    relay('contact:updated', CONTACT_UPDATED_EVENT);
    relay('contact:remarks', CONTACT_REMARKS_EVENT);
    socket.on('contact:properties', () => window.dispatchEvent(new Event(CUSTOM_PROPERTIES_EVENT)));
    socket.on('leadStages:changed', (d: { moved?: { from: string; to: string | null } }) => stagesChanged(d ?? {}));
    relay('contact:lists', CONTACT_LISTS_EVENT);
    relay('contactList:saved', CONTACT_LIST_SAVED_EVENT);
    relay('contactList:deleted', CONTACT_LIST_DELETED_EVENT);
    socket.on('label:saved', () => fetchLabels().then(setLabels).catch(() => {}));
    socket.on('label:deleted', () => fetchLabels().then(setLabels).catch(() => {}));
    if (conversationId) {
      socket.on('conversation:labels', ({ conversationId: id, labels: next }: { conversationId: string; labels: Conversation['labels'] }) => {
        if (id === conversationId) setConversation((c) => (c ? { ...c, labels: next } : c));
      });
      // Chat events and this page's own profile entries (contact:activity: profile edits and remarks)
      const addActivity = (a: Activity) => {
        if (a.conversationId === conversationId) setActivity((prev) => (prev && !prev.some((x) => x.id === a.id) ? [a, ...prev] : prev));
      };
      socket.on('activity:new', addActivity);
      socket.on('contact:activity', addActivity);
      const reloadIfMine = (id?: string) => id === conversationId && loadConversation();
      socket.on('conversation:assigned', (e: { conversationId: string }) => reloadIfMine(e?.conversationId));
      socket.on('conversation:status', (e: { conversationId: string }) => reloadIfMine(e?.conversationId));
      socket.on('message:new', (e: { message?: { conversationId: string } }) => reloadIfMine(e?.message?.conversationId));
    }
    return () => {
      socket.disconnect();
    };
  }, [conversationId, loadConversation]);
  // Profile edits and list changes made here or by teammates
  useEffect(() => {
    const onUpdated = (e: Event) => {
      const c = (e as CustomEvent<ContactProfile>).detail;
      if (c?.id === contactId) setContact((prev) => (prev ? { ...prev, ...c } : prev));
    };
    const onRemarks = (e: Event) => {
      if ((e as CustomEvent<{ contactId: string }>).detail?.contactId === contactId) fetchRemarks(contactId).then(setRemarks).catch(() => {});
    };
    const onLists = (e: Event) => {
      const d = (e as CustomEvent<{ contactId: string; lists: ContactProfile['lists'] }>).detail;
      if (d?.contactId === contactId) setContact((prev) => (prev ? { ...prev, lists: d.lists } : prev));
    };
    const onListDeleted = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      setContact((prev) => (prev ? { ...prev, lists: prev.lists.filter((l) => l.id !== id) } : prev));
    };
    window.addEventListener(CONTACT_UPDATED_EVENT, onUpdated);
    window.addEventListener(CONTACT_REMARKS_EVENT, onRemarks);
    window.addEventListener(CONTACT_LISTS_EVENT, onLists);
    window.addEventListener(CONTACT_LIST_DELETED_EVENT, onListDeleted);
    return () => {
      window.removeEventListener(CONTACT_UPDATED_EVENT, onUpdated);
      window.removeEventListener(CONTACT_REMARKS_EVENT, onRemarks);
      window.removeEventListener(CONTACT_LISTS_EVENT, onLists);
      window.removeEventListener(CONTACT_LIST_DELETED_EVENT, onListDeleted);
    };
  }, [contactId]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenuOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const shownActivity = useMemo(() => (activity ?? []).filter((a) => filter === 'all' || activityKind(a) === filter), [activity, filter]);
  const months = useMemo(() => groupByMonth(shownActivity), [shownActivity]);
  const viewer = permissions && { userId: permissions.userId, isAdmin: ['owner', 'admin'].includes(permissions.role) };

  if (error) return <p className="m-6 rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger">{error}</p>;
  if (!contact) return <p className="p-6 text-sm text-muted">Loading contact…</p>;

  const name = profileName(contact);
  const toastDetail = contact.name || `+${contact.waId}`;
  const openChat = () => conversationId && router.push(`/inbox?chat=${encodeURIComponent(conversationId)}`);

  async function setStage(value: string) {
    try {
      const c = await updateContact(contact!.id, { leadStage: value });
      setContact((prev) => (prev ? { ...prev, ...c } : prev));
      showToast(`stage:${Date.now()}`, conversationId ?? '', 'Lead stage saved.', toastDetail);
    } catch (e) {
      showToast(`stage-err:${Date.now()}`, '', (e as Error).message, '');
    }
  }

  // Admins: the contact and its chat go to Settings → Recently deleted contacts (restorable for a while)
  async function removeContact() {
    setDeleteBusy(true);
    try {
      await deleteContact(contact!.id);
      showToast(`deleted:${Date.now()}`, '', `${name} deleted. Restore it from Settings → Recently deleted contacts.`, 'Contact deleted');
      router.replace('/inbox');
    } catch (e) {
      setError((e as Error).message);
      setDeleteBusy(false);
      setConfirmDelete(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-page">
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${name}?`}
          body="The contact and their chat are removed from the app. You can restore them from Settings → Recently deleted contacts until they are permanently deleted."
          yes="Delete contact"
          danger
          busy={deleteBusy}
          onYes={removeContact}
          onNo={() => setConfirmDelete(false)}
        />
      )}
      {/* Header row: back, title */}
      <div className="flex h-16 shrink-0 items-center border-b border-line/90 bg-surface">
        <button
          type="button"
          onClick={() => (window.history.length > 1 ? router.back() : router.push('/inbox'))}
          title="Back"
          aria-label="Back"
          className="flex h-full w-16 items-center justify-center border-r border-line/90 text-body-soft transition hover:bg-surface-muted hover:text-body"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <h1 className="px-8 text-[22px] font-bold tracking-tight text-ink">View contact details</h1>
      </div>
      <div className="flex min-h-0 flex-1">
      {/* Left: who and their properties */}
      <aside aria-label="Contact" className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-r border-line/90 bg-surface" style={{ scrollbarGutter: 'stable' }}>
        <div className="relative flex flex-col items-center px-5 pt-6 pb-5">
          <div ref={menuRef} className="absolute right-3 top-3">
            <button type="button" title="More" aria-label="More" onClick={() => setMenuOpen((o) => !o)} className={iconButton}>
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="5" r="1.8" />
                <circle cx="12" cy="12" r="1.8" />
                <circle cx="12" cy="19" r="1.8" />
              </svg>
            </button>
            {menuOpen && (
              <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-48 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-xl">
                <button type="button" role="menuitem" disabled={!conversationId} onClick={openChat} className="block w-full px-4 py-2 text-left text-[13px] text-ink hover:bg-surface-muted disabled:opacity-50">
                  Open chat
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    navigator.clipboard
                      ?.writeText(`+${contact.waId}`)
                      .then(() => showToast(`copy:${Date.now()}`, '', 'Phone number copied.', `+${contact.waId}`))
                      .catch(() => {});
                  }}
                  className="block w-full px-4 py-2 text-left text-[13px] text-ink hover:bg-surface-muted"
                >
                  Copy phone number
                </button>
                {viewer?.isAdmin && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setConfirmDelete(true);
                    }}
                    className="block w-full border-t border-line-soft px-4 py-2 text-left text-[13px] text-danger hover:bg-danger-soft"
                  >
                    Delete contact
                  </button>
                )}
              </div>
            )}
          </div>
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-secondary text-xl font-bold text-on-primary">{name.replace(/^\+/, '').charAt(0).toUpperCase()}</span>
          <h2 className="mt-3 max-w-full truncate text-[15px] font-bold text-ink" title={name}>
            {name}
          </h2>
          <button
            type="button"
            disabled={!conversationId}
            onClick={openChat}
            className="mt-3 rounded-lg border border-primary px-5 py-1.5 text-xs font-semibold text-primary transition hover:bg-primary-subtle disabled:opacity-50"
          >
            Send message
          </button>
        </div>

        <div className="border-t border-line-soft px-5 py-4">
          <div className="flex overflow-hidden rounded-md border border-line focus-within:border-primary">
            <select
              value={contact.leadStage ?? ''}
              onChange={(e) => setStage(e.target.value)}
              aria-label="Lead stage"
              className="min-w-0 flex-1 cursor-pointer bg-surface px-2.5 py-1.5 text-xs text-body outline-hidden"
            >
              <option value="">Select stage</option>
              {options?.leadStages.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {(() => {
              const next = nextStage(options?.leadStages ?? [], contact.leadStage);
              return (
                <button
                  type="button"
                  disabled={!next}
                  onClick={() => next && setStage(next.value)}
                  title={next ? `Move to ${next.label}` : 'Already at the last stage'}
                  aria-label={next ? `Move to ${next.label}` : 'Next stage'}
                  className="flex w-8 shrink-0 items-center justify-center border-l border-line text-primary hover:bg-surface-muted disabled:text-faint"
                >
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </button>
              );
            })()}
          </div>
        </div>

        <div className="border-t border-line-soft px-5 py-4">
          <h3 className="text-[13px] font-semibold text-ink">Activity</h3>
          <p className="mt-2.5 flex items-center gap-2 text-xs text-body">
            <svg className="h-4 w-4 text-body-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
            {joinedText(contact.createdAt)}
          </p>
          <p className="mt-2 flex items-center gap-2 text-xs text-body">
            <svg className="h-4 w-4 text-body-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            {conversation?.lastMessageAt ? `Last message ${timeAgo(conversation.lastMessageAt)}` : 'No messages yet'}
          </p>
        </div>

        <div className="border-t border-line-soft px-5 py-4">
          <h3 className="text-[13px] font-semibold text-ink">Contact info</h3>
          <p className="mt-2.5 flex items-center gap-2 text-xs text-body">
            <svg className="h-4 w-4 text-body-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />
            </svg>
            +{contact.waId}
          </p>
          <p className="mt-2 flex items-center gap-2 text-xs text-body">
            <svg className="h-4 w-4 text-body-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m22 7-10 6L2 7" />
            </svg>
            {contact.email || '–'}
          </p>
        </div>

        <div className="border-t border-line-soft">
          <Properties
            contact={contact}
            owner={conversation?.assignee?.name ?? null}
            options={options}
            chat={chat}
            onSaved={(c, label) => {
              setContact((prev) => (prev ? { ...prev, ...c } : prev));
              showToast(`contact:${c.id}:${Date.now()}`, conversationId ?? '', `${label} saved.`, toastDetail);
            }}
          />
        </div>
      </aside>

      {/* Middle: tabs */}
      <section aria-label="Contact tabs" className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="shrink-0 border-b border-line px-8 pt-5 bg-page">
          <div role="tablist" aria-label="Contact details" className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`-mb-px border-b-2 px-3 py-2.5 text-[13px] font-semibold transition ${tab === t.key ? 'border-primary text-primary' : 'border-transparent text-body-soft hover:text-body'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-8 py-5" style={{ scrollbarGutter: 'stable' }}>

        {tab === 'activity' && (
          <section aria-label="Activity log" className="mt-5">
            <label className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-wide text-muted">
              Filter by
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                aria-label="Filter activity"
                className="cursor-pointer rounded-lg border border-transparent bg-transparent px-1.5 py-1 text-[13px] font-normal normal-case tracking-normal text-body hover:border-line focus:border-primary"
              >
                {ACTIVITY_FILTERS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            {activity === null ? (
              <p className="mt-6 text-xs text-faint">Loading activity…</p>
            ) : months.length === 0 ? (
              <EmptyState title="No activity yet" text={filter === 'all' ? 'Assignments, labels, status changes and messages for this customer will show here.' : 'Nothing of this kind yet. Try another filter.'} />
            ) : (
              months.map((m) => (
                <div key={m.month} className="mt-5">
                  <h3 className="text-[15px] font-semibold text-ink">{m.month}</h3>
                  <ul className="mt-3 space-y-3">
                    {m.items.map((a) => {
                      const kind = activityKind(a);
                      return (
                        <li key={a.id} className="rounded-lg bg-surface px-6 py-5 shadow-[0_1px_3px_rgba(16,24,40,0.08)]">
                          <div className="flex items-center justify-between gap-3">
                            <span className={`text-[10px] font-bold uppercase tracking-wide ${kind === 'user' ? 'text-primary' : kind === 'customer' ? 'text-secondary' : 'text-muted'}`}>
                              {kind === 'user' ? 'User activity' : kind === 'customer' ? 'Customer message' : 'System activity'}
                            </span>
                            <span className="shrink-0 text-[11px] text-faint">{formatDateTime(a.createdAt)}</span>
                          </div>
                          {(() => {
                            const card = activityCard(a);
                            return (
                              <>
                                <p className="mt-1.5 text-[13px] font-semibold text-ink">{card.title}</p>
                                {card.lines.length > 0 && (
                                  <div className="mt-2.5 space-y-0.5 text-[13px] text-body">
                                    {card.lines.map((line, i) => (
                                      <p key={i} className="whitespace-pre-wrap break-words">
                                        {line}
                                      </p>
                                    ))}
                                  </div>
                                )}
                              </>
                            );
                          })()}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))
            )}
          </section>
        )}

        {tab === 'associations' && (
          <section aria-label="Associations" className="mt-5">
            {conversation ? (
              <div className="flex items-center justify-between gap-4 rounded-xl border border-line-soft bg-surface px-5 py-4 shadow-2xs">
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-primary">WhatsApp chat</p>
                  <p className="mt-1 text-[13px] text-ink">
                    {conversation.status === 'closed' ? 'Closed' : conversation.status === 'snoozed' ? 'Snoozed' : 'Open'} · {conversation.assignee ? `Assigned to ${conversation.assignee.name}` : 'Unassigned'}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted">Last message {formatDateTime(conversation.lastMessageAt)}</p>
                </div>
                <button type="button" onClick={openChat} className="shrink-0 rounded-lg bg-primary px-4 py-1.5 text-xs font-semibold text-on-primary hover:opacity-90">
                  Open chat
                </button>
              </div>
            ) : (
              <EmptyState title="No associations" text="This customer has no chat yet." />
            )}
          </section>
        )}

        {tab === 'remarks' && (
          <div className="mt-3 max-w-2xl rounded-xl border border-line-soft bg-surface">
            <Remarks
              contactId={contact.id}
              conversationId={conversationId ?? ''}
              remarks={remarks}
              setRemarks={setRemarks}
              viewer={viewer}
              maxLength={options?.remarkMaxLength ?? 2000}
              toastDetail={toastDetail}
            />
          </div>
        )}

        {tab === 'media' && <MediaTab key={mediaType} conversationId={conversationId} initialType={mediaType} />}
        </div>
      </section>

      {/* Right: labels and lists */}
      <aside aria-label="Labels and lists" className="w-[300px] shrink-0 overflow-y-auto border-l border-line/90 bg-surface" style={{ scrollbarGutter: 'stable' }}>
        <section className="relative border-b border-line-soft px-5 py-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[13px] font-semibold text-ink">Labels</h3>
            <button
              ref={labelsButtonRef}
              type="button"
              data-labels-toggle
              title="Add label"
              aria-label="Add label"
              disabled={!conversation}
              onClick={() => setLabelsOpen((o) => !o)}
              className={`${iconButton} ${labelsOpen ? 'text-primary' : ''}`}
            >
              <PlusIcon />
            </button>
          </div>
          {conversation && conversation.labels.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {conversation.labels.map((l) => (
                <LabelPill key={l.id} name={l.name} color={l.color} />
              ))}
            </div>
          ) : (
            <EmptyState title="No labels here" text='Add labels to this contact with the "+" icon.' />
          )}
          {labelsOpen && conversation && (
            <LabelsDropdown
              conversation={conversation}
              labels={labels}
              onConversationLabels={(id, next) => {
                setConversation((c) => (c && c.id === id ? { ...c, labels: next } : c));
                fetchLabels().then(setLabels).catch(() => {});
              }}
              onClose={() => setLabelsOpen(false)}
            />
          )}
        </section>
        <section className="relative border-b border-line-soft px-5 py-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[13px] font-semibold text-ink">Lists</h3>
            <button type="button" data-lists-toggle title="Add to list" aria-label="Add to list" onClick={() => setListsOpen((o) => !o)} className={`${iconButton} ${listsOpen ? 'text-primary' : ''}`}>
              <PlusIcon />
            </button>
          </div>
          {contact.lists.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {contact.lists.map((l) => (
                <span key={l.id} className="inline-flex max-w-full items-center truncate rounded-full bg-surface-strong px-2.5 py-1 text-[11px] font-medium text-body">
                  {l.name}
                </span>
              ))}
            </div>
          ) : (
            <EmptyState title="No lists here" text='Add this contact to lists like VIP customers or event attendees with the "+" icon.' />
          )}
          {listsOpen && (
            <ListsDropdown
              contactId={contact.id}
              conversationId={conversationId ?? ''}
              contactName={toastDetail}
              memberOf={contact.lists}
              canDelete={!!viewer?.isAdmin}
              onChanged={(lists) => setContact((prev) => (prev ? { ...prev, lists } : prev))}
              onClose={() => setListsOpen(false)}
            />
          )}
        </section>
      </aside>

      </div>

      {picker && conversation && (
        <LabelPicker
          anchor={picker}
          conversation={conversation}
          labels={labels}
          canManage={!!permissions?.canManageLabels}
          onClose={() => setPicker(null)}
          onLabelSaved={() => fetchLabels().then(setLabels).catch(() => {})}
          onLabelDeleted={() => fetchLabels().then(setLabels).catch(() => {})}
          onConversationLabels={(id, next) => setConversation((c) => (c && c.id === id ? { ...c, labels: next } : c))}
        />
      )}
    </div>
  );
}
