'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  type ChatDetails,
  type ChatFile,
  type Payment,
  PAYMENT_FILTERS,
  type ContactFieldOptions,
  type ContactProfile,
  type ContactRemark,
  type PropertyRow,
  type PropertyView,
  DEFAULT_VIEW,
  applyView,
  fetchPropertyView,
  PROPERTY_VIEW_EVENT,
  savePropertyView,
  addRemark,
  deleteRemark,
  displayValue,
  fetchChatDetails,
  fetchChatFiles,
  fetchContact,
  fetchContactFieldOptions,
  fetchRemarks,
  fileLabel,
  filterPayments,
  splitFiles,
  filterRows,
  profileName,
  propertyRows,
  customRows,
  withLabels,
  fetchCustomProperties,
  setCustomValue,
  CUSTOM_PROPERTIES_EVENT,
  type CustomProperty,
  updateContact,
  updateRemark,
} from '@/lib/contacts';
import type { Conversation } from '@/lib/inbox';
import { formatDateTime } from '@/lib/time';
import { showToast } from '@/lib/toasts';
import type { Label } from '@/lib/labels';
import { LabelPill, LabelsDropdown } from './LabelsDropdown';
import { CONTACT_LIST_DELETED_EVENT, ListsDropdown } from './ListsDropdown';
import { PropertySettings } from './PropertySettings';
import { useStagesChanged } from './StageMenu';
import { MediaViewer } from './composerExtras';
import { downloadFile } from '@/lib/media';
import { filterDialCountries } from '@/lib/profileOptions';
import { SearchSelect } from '../SearchSelect';

// Live updates from the inbox page's socket (contact:updated / contact:remarks), passed on as window events
export const CONTACT_UPDATED_EVENT = 'app:contact-updated';
export const CONTACT_REMARKS_EVENT = 'app:contact-remarks';
export const CONTACT_LISTS_EVENT = 'app:contact-lists';

export const PlusIcon = () => (
  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v8M8 12h8" />
  </svg>
);

export function Section({ title, action, children }: { title: string; action?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <section className="relative border-b border-line-soft px-5 py-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

// Your Contact property view, loaded once (only yours; saved on the server)
let cachedView: PropertyView | null = null;

// The panel's tabs (the icon row under the name). Stays on the same tab as you move between chats.
type Tab = 'profile' | 'objects' | 'orders' | 'files';
// Remembered in this browser too, so a refresh comes back to the same tab
const TAB_KEY = 'support:profileTab';
let lastTab: Tab | null = null;
function readTab(): Tab {
  if (lastTab) return lastTab;
  try {
    const t = localStorage.getItem(TAB_KEY);
    lastTab = t === 'objects' || t === 'orders' || t === 'files' ? t : 'profile';
  } catch {
    lastTab = 'profile';
  }
  return lastTab;
}
const TAB_ICONS: Record<Tab, React.ReactNode> = {
  profile: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  objects: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </>
  ),
  orders: (
    <>
      <path d="M6 7h12l1 14H5L6 7z" />
      <path d="M9 7a3 3 0 0 1 6 0" />
    </>
  ),
  files: <path d="m21 11-8.6 8.6a5 5 0 0 1-7-7l8.5-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />,
};
const TABS: { key: Tab; label: string }[] = [
  { key: 'profile', label: 'Profile' },
  { key: 'objects', label: 'Custom objects' },
  { key: 'orders', label: 'Orders' },
  { key: 'files', label: 'Attachments' },
];

function EmptyTab({ icon, title, text, action }: { icon: React.ReactNode; title: string; text: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-8 py-8 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-strong text-body-soft">
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          {icon}
        </svg>
      </span>
      <p className="mt-3 text-[13px] font-bold text-ink">{title}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">{text}</p>
      {action}
    </div>
  );
}

export const iconButton = 'flex h-7 w-7 items-center justify-center rounded-full text-body-soft transition hover:bg-surface-strong hover:text-body';

// Chat side panel: the customer's profile. Opened from the (i) button in the chat header.
export function ContactPanel({
  conversation,
  viewer,
  labels,
  onConversationLabels,
  onOpenLabels,
  onClose,
}: {
  conversation: Conversation;
  viewer: { userId: string; isAdmin: boolean } | null;
  // All workspace labels, for the Labels dropdown
  labels: Label[];
  onConversationLabels: (conversationId: string, labels: Conversation['labels']) => void;
  // "Manage labels": the full label editor (create, rename, recolour, delete)
  onOpenLabels: (anchor: HTMLElement) => void;
  onClose: () => void;
}) {
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [listsOpen, setListsOpen] = useState(false);
  const labelsButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setLabelsOpen(false);
    setListsOpen(false);
  }, [conversation.id]);
  const contactId = conversation.contact.id;
  const [contact, setContact] = useState<ContactProfile | null>(null);
  const [options, setOptions] = useState<ContactFieldOptions | null>(null);
  const [remarks, setRemarks] = useState<ContactRemark[] | null>(null);
  const [error, setError] = useState('');
  // Channel and last contact times (refreshed when a message comes or goes in this chat)
  const [chat, setChat] = useState<ChatDetails | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchChatDetails(conversation.id)
      .then((d) => !cancelled && setChat(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversation.id, conversation.lastMessageAt]);
  const [tab, setTabState] = useState<Tab>(readTab);
  const setTab = (t: Tab) => {
    lastTab = t;
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      // private mode: just not remembered
    }
    setTabState(t);
  };

  // Load (and reload when another chat is opened)
  useEffect(() => {
    let cancelled = false;
    setContact(null);
    setRemarks(null);
    setError('');
    fetchContact(contactId)
      .then((c) => !cancelled && setContact(c))
      .catch((e) => !cancelled && setError((e as Error).message));
    fetchRemarks(contactId)
      .then((r) => !cancelled && setRemarks(r))
      .catch(() => !cancelled && setRemarks([]));
    fetchContactFieldOptions()
      .then((o) => !cancelled && setOptions(o))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  // Stages renamed, recoloured, added or deleted: show them; a deleted stage moved this customer
  useStagesChanged(({ moved }) => {
    fetchContactFieldOptions(true).then(setOptions).catch(() => {});
    if (moved) setContact((prev) => (prev && prev.leadStage === moved.from ? { ...prev, leadStage: moved.to } : prev));
  });

  // A teammate changed the profile or the remarks: follow along
  useEffect(() => {
    const onUpdated = (e: Event) => {
      const c = (e as CustomEvent<ContactProfile>).detail;
      if (c?.id === contactId) setContact((prev) => ({ ...(prev ?? c), ...c }));
    };
    const onRemarks = (e: Event) => {
      if ((e as CustomEvent<{ contactId: string }>).detail?.contactId === contactId) fetchRemarks(contactId).then(setRemarks).catch(() => {});
    };
    const onLists = (e: Event) => {
      const d = (e as CustomEvent<{ contactId: string; lists: ContactProfile['lists'] }>).detail;
      if (d?.contactId === contactId) setContact((prev) => (prev ? { ...prev, lists: d.lists } : prev));
    };
    window.addEventListener(CONTACT_UPDATED_EVENT, onUpdated);
    window.addEventListener(CONTACT_REMARKS_EVENT, onRemarks);
    window.addEventListener(CONTACT_LISTS_EVENT, onLists);
    // A list was deleted (by anyone): this customer is no longer in it
    const onListDeleted = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      setContact((prev) => (prev && prev.lists.some((l) => l.id === id) ? { ...prev, lists: prev.lists.filter((l) => l.id !== id) } : prev));
    };
    window.addEventListener(CONTACT_LIST_DELETED_EVENT, onListDeleted);
    return () => {
      window.removeEventListener(CONTACT_LIST_DELETED_EVENT, onListDeleted);
      window.removeEventListener(CONTACT_UPDATED_EVENT, onUpdated);
      window.removeEventListener(CONTACT_REMARKS_EVENT, onRemarks);
      window.removeEventListener(CONTACT_LISTS_EVENT, onLists);
    };
  }, [contactId]);

  const name = contact ? profileName(contact) : conversation.contact.name || `+${conversation.contact.waId}`;
  const toastDetail = conversation.contact.name || `+${conversation.contact.waId}`;

  return (
    <aside aria-label="Contact profile" className="flex h-full w-[320px] shrink-0 flex-col border-l border-line/90 bg-surface">
      {/* Header (stays put while the sections scroll): open the full contact page, close; who; the tabs */}
      <div className="shrink-0 border-b border-line-soft">
        <div className="flex h-10 items-center justify-end gap-0.5 px-3">
          <Link href={`/contacts/${encodeURIComponent(conversation.contact.id)}`} title="View contact details" aria-label="View contact details" className={iconButton}>
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6" />
              <path d="M10 14 21 3" />
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            </svg>
          </Link>
          <button type="button" onClick={onClose} title="Close profile" aria-label="Close profile" className={iconButton}>
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex gap-4 px-5 pb-4">
          <span className="mt-1 flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-secondary text-lg font-bold text-on-primary">
            {name.replace(/^\+/, '').charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p title={name} className="truncate text-[15px] font-bold text-ink">
              {name}
            </p>
            <p className="truncate text-xs text-muted">+{conversation.contact.waId}</p>
            <p className="truncate text-xs text-muted">{contact?.email || '–'}</p>
            <div role="tablist" aria-label="Profile sections" className="mt-3 flex items-center gap-1.5">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  aria-label={t.label}
                  title={t.label}
                  onClick={() => setTab(t.key)}
                  className={`flex h-8 w-8 items-center justify-center rounded-lg transition ${tab === t.key ? 'text-primary' : 'text-body-soft hover:bg-surface-strong hover:text-body'}`}
                >
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={tab === t.key ? 2 : 1.7} strokeLinecap="round" strokeLinejoin="round">
                    {TAB_ICONS[t.key]}
                  </svg>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" style={{ scrollbarGutter: 'stable' }}>
        {tab === 'objects' && (
          <EmptyTab
            icon={
              <>
                <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                <path d="M14 3v5h5" />
                <circle cx="11.5" cy="14.5" r="2.5" />
                <path d="m13.5 16.5 2 2" />
              </>
            }
            title="No data here"
            text="Set up custom objects to display records like orders, bookings, or memberships here."
            action={
              <>
                <button type="button" disabled title="Custom objects aren't available yet" className="mt-4 cursor-not-allowed rounded-lg bg-primary px-5 py-2 text-xs font-semibold text-on-primary opacity-60">
                  Set up custom objects
                </button>
                <p className="mt-2 text-[11px] text-faint">Coming soon</p>
              </>
            }
          />
        )}
        {tab === 'orders' && <Payments />}
        {tab === 'files' && <Files conversationId={conversation.id} contactId={conversation.contact.id} />}

        {tab === 'profile' && (
        <>
        {error && <p className="mx-5 mt-3 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}

        <Remarks contactId={contactId} remarks={remarks} setRemarks={setRemarks} viewer={viewer} maxLength={options?.remarkMaxLength ?? 2000} toastDetail={toastDetail} conversationId={conversation.id} />

        <Section
          title="Labels"
          action={
            <button
              ref={labelsButtonRef}
              type="button"
              data-labels-toggle
              title="Add label"
              aria-label="Add label"
              aria-expanded={labelsOpen}
              onClick={() => setLabelsOpen((o) => !o)}
              className={`${iconButton} ${labelsOpen ? 'text-primary' : ''}`}
            >
              <PlusIcon />
            </button>
          }
        >
          {conversation.labels.length > 0 ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {conversation.labels.map((l) => (
                <LabelPill key={l.id} name={l.name} color={l.color} />
              ))}
            </div>
          ) : (
            <p className="mt-1.5 text-xs text-faint">No labels on this chat</p>
          )}
          {labelsOpen && (
            <LabelsDropdown
              conversation={conversation}
              labels={labels}
              onConversationLabels={onConversationLabels}
              onClose={() => setLabelsOpen(false)}
            />
          )}
        </Section>

        <Section
          title="Lists"
          action={
            <button
              type="button"
              data-lists-toggle
              title="Add to list"
              aria-label="Add to list"
              aria-expanded={listsOpen}
              disabled={!contact}
              onClick={() => setListsOpen((o) => !o)}
              className={`${iconButton} ${listsOpen ? 'text-primary' : ''}`}
            >
              <PlusIcon />
            </button>
          }
        >
          {contact && contact.lists.length > 0 ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {contact.lists.map((l) => (
                <span key={l.id} className="inline-flex max-w-full items-center truncate rounded-full bg-surface-strong px-2.5 py-1 text-[11px] font-medium text-body">
                  {l.name}
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-1.5 text-xs text-faint">Not in any list</p>
          )}
          {listsOpen && contact && (
            <ListsDropdown
              contactId={contact.id}
              conversationId={conversation.id}
              contactName={toastDetail}
              memberOf={contact.lists}
              canDelete={!!viewer?.isAdmin}
              onChanged={(lists) => setContact((prev) => (prev ? { ...prev, lists } : prev))}
              onClose={() => setListsOpen(false)}
            />
          )}
        </Section>

        {contact ? (
          <Properties
            contact={contact}
            owner={conversation.assignee?.name ?? null}
            options={options}
            chat={chat}
            onSaved={(c, label) => {
              setContact(c);
              showToast(`contact:${c.id}:${Date.now()}`, conversation.id, `${label} saved.`, toastDetail);
            }}
          />
        ) : (
          !error && <p className="px-5 py-4 text-xs text-faint">Loading contact details…</p>
        )}
        </>
        )}
      </div>
    </aside>
  );
}

export function Remarks({
  contactId,
  conversationId,
  remarks,
  setRemarks,
  viewer,
  maxLength,
  toastDetail,
}: {
  contactId: string;
  conversationId: string;
  remarks: ContactRemark[] | null;
  setRemarks: (r: ContactRemark[] | ((prev: ContactRemark[] | null) => ContactRemark[] | null)) => void;
  viewer: { userId: string; isAdmin: boolean } | null;
  maxLength: number;
  toastDetail: string;
}) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setAdding(false);
    setText('');
    setError('');
  }, [contactId]);

  async function save() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await addRemark(contactId, body);
      setRemarks((prev) => [r, ...(prev ?? []).filter((x) => x.id !== r.id)]);
      setText('');
      setAdding(false);
      showToast(`remark:add:${r.id}`, conversationId, 'Remark added.', toastDetail);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Editing a remark in place (one at a time)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const editRef = useRef<HTMLTextAreaElement>(null);
  function startEdit(r: ContactRemark) {
    setEditingId(r.id);
    setEditText(r.body);
    setError('');
    setTimeout(() => {
      const el = editRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }, 0);
  }
  async function saveEdit(r: ContactRemark) {
    const body = editText.trim();
    if (!body || busy) return;
    if (body === r.body) return setEditingId(null);
    setBusy(true);
    setError('');
    try {
      const updated = await updateRemark(r.id, body);
      setRemarks((prev) => (prev ?? []).map((x) => (x.id === updated.id ? updated : x)));
      setEditingId(null);
      showToast(`remark:edit:${r.id}:${Date.now()}`, conversationId, 'Remark updated.', toastDetail);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => setEditingId(null), [contactId]);

  async function remove(r: ContactRemark) {
    if (!confirm('Delete this remark?')) return;
    setError('');
    try {
      await deleteRemark(r.id);
      setRemarks((prev) => (prev ?? []).filter((x) => x.id !== r.id));
      showToast(`remark:del:${r.id}`, conversationId, 'Remark deleted.', toastDetail);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Section
      title="Remarks"
      action={
        <button
          type="button"
          title="Add remark"
          aria-label="Add remark"
          onClick={() => {
            setAdding(true);
            setTimeout(() => ref.current?.focus(), 0);
          }}
          className={iconButton}
        >
          <PlusIcon />
        </button>
      }
    >
      {adding && (
        <div className="mt-2.5">
          <textarea
            ref={ref}
            value={text}
            maxLength={maxLength}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setAdding(false);
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
            }}
            rows={3}
            placeholder="Internal note about this customer (only your team sees it)"
            className="w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink outline-hidden placeholder:text-faint focus:border-primary focus:ring-1 focus:ring-primary"
          />
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-[10px] text-faint">
              {text.length}/{maxLength}
            </span>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => setAdding(false)} className="rounded-lg px-2.5 py-1 text-xs text-body-soft hover:bg-surface-strong">
                Cancel
              </button>
              <button type="button" disabled={!text.trim() || busy} onClick={save} className="rounded-lg bg-primary px-3 py-1 text-xs font-semibold text-on-primary hover:opacity-90 disabled:opacity-50">
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
      {error && <p className="mt-2 rounded-lg bg-danger-soft px-2.5 py-1.5 text-xs text-danger">{error}</p>}
      {remarks === null ? (
        <p className="mt-1.5 text-xs text-faint">Loading…</p>
      ) : remarks.length === 0 ? (
        !adding && <p className="mt-1.5 text-xs text-faint">No remarks yet</p>
      ) : (
        <ul className="mt-2.5 space-y-2">
          {remarks.map((r) => (
            <li key={r.id} className="group rounded-lg bg-surface-muted px-3 py-2">
              {editingId === r.id ? (
                <div>
                  <textarea
                    ref={editRef}
                    value={editText}
                    maxLength={maxLength}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setEditingId(null);
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit(r);
                    }}
                    rows={3}
                    aria-label="Edit remark"
                    className="w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink outline-hidden focus:border-primary focus:ring-1 focus:ring-primary"
                  />
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-[10px] text-faint">
                      {editText.length}/{maxLength}
                    </span>
                    <div className="flex gap-1.5">
                      <button type="button" onClick={() => setEditingId(null)} className="rounded-lg px-2.5 py-1 text-xs text-body-soft hover:bg-surface-strong">
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={!editText.trim() || editText.trim() === r.body || busy}
                        onClick={() => saveEdit(r)}
                        className="rounded-lg bg-primary px-3 py-1 text-xs font-semibold text-on-primary hover:opacity-90 disabled:opacity-50"
                      >
                        {busy ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <p className="whitespace-pre-wrap break-words text-xs text-ink">{r.body}</p>
                  <div className="mt-1 flex items-start justify-between gap-2">
                    <span className="min-w-0 text-[10px] leading-4 text-muted" title={r.editedAt ? `Edited ${formatDateTime(r.editedAt)}` : undefined}>
                      {r.authorName ?? 'Former member'} · {formatDateTime(r.createdAt)}
                      {r.editedAt && ' · edited'}
                    </span>
                    {viewer && (viewer.isAdmin || viewer.userId === r.createdById) && (
                      <span className="flex shrink-0 items-center gap-1">
                        <button type="button" onClick={() => startEdit(r)} title="Edit remark" aria-label="Edit remark" className="rounded px-1 text-[10px] text-faint hover:text-primary">
                          Edit
                        </button>
                        <button type="button" onClick={() => remove(r)} title="Delete remark" aria-label="Delete remark" className="rounded px-1 text-[10px] text-faint hover:text-danger">
                          Delete
                        </button>
                      </span>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function Properties({
  contact,
  owner,
  options,
  chat,
  onSaved,
}: {
  contact: ContactProfile;
  owner: string | null;
  options: ContactFieldOptions | null;
  chat: ChatDetails | null;
  onSaved: (c: ContactProfile, label: string) => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<PropertyRow['key'] | null>(null);
  const [custom, setCustom] = useState<CustomProperty[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  // Your view (Default = every property; Personal = your order and hidden ones), kept while you move between chats
  const [view, setViewState] = useState<PropertyView>(cachedView ?? DEFAULT_VIEW);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [viewError, setViewError] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const load = () =>
      fetchPropertyView()
        .then((v) => {
          cachedView = v;
          setViewState(v);
        })
        .catch(() => {});
    const loadCustom = (fresh: boolean) =>
      fetchCustomProperties(fresh)
        .then(setCustom)
        .catch(() => {});
    load(); // the cached view shows at once; this picks up changes made elsewhere (e.g. an admin's default view)
    loadCustom(false);
    // Changed in Settings → Contact properties (here or by an admin anywhere): show the new layout and columns
    const onProperties = () => {
      load();
      loadCustom(true);
    };
    window.addEventListener(PROPERTY_VIEW_EVENT, load);
    window.addEventListener(CUSTOM_PROPERTIES_EVENT, onProperties);
    return () => {
      window.removeEventListener(PROPERTY_VIEW_EVENT, load);
      window.removeEventListener(CUSTOM_PROPERTIES_EVENT, onProperties);
    };
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenuOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);
  async function changeView(next: Pick<PropertyView, 'personal' | 'order' | 'hidden'>, message: string) {
    setViewError('');
    const saved = await savePropertyView(next);
    cachedView = saved;
    setViewState(saved);
    showToast(`view:${Date.now()}`, '', message, '');
  }
  const allRows = [...withLabels(propertyRows(contact, owner, options, chat), view.labels), ...customRows(contact, custom)];
  const rows = filterRows(applyView(allRows, view), query);

  return (
    <Section
      title={view.personal ? 'Contact property · Personal view' : 'Contact property'}
      action={
        <div className="flex items-center">
        <button
          type="button"
          title="Search properties"
          aria-label="Search properties"
          aria-pressed={searchOpen}
          onClick={() => {
            const open = !searchOpen;
            setSearchOpen(open);
            if (!open) setQuery('');
            else setTimeout(() => searchRef.current?.focus(), 0);
          }}
          className={`${iconButton} ${searchOpen ? 'text-primary' : ''}`}
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </button>
        <div ref={menuRef} className="relative">
          <button
            type="button"
            title="View options"
            aria-label="View options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
            className={`${iconButton} ${menuOpen ? 'text-primary' : ''}`}
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="1.8" />
              <circle cx="12" cy="12" r="1.8" />
              <circle cx="12" cy="19" r="1.8" />
            </svg>
          </button>
          {menuOpen && (
            <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-60 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-xl">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  const next = { ...view, personal: !view.personal };
                  changeView(next, view.personal ? 'Switched to the default view.' : 'Switched to your personal view.').catch((e) => setViewError((e as Error).message));
                }}
                className="block w-full px-4 py-2.5 text-left text-[13px] text-primary hover:bg-surface-muted"
              >
                {view.personal ? 'Switch to “Default view”' : 'Update to “Personal view”'}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setSettingsOpen(true);
                }}
                className="block w-full px-4 py-2.5 text-left text-[13px] text-ink hover:bg-surface-muted"
              >
                Manage column settings
              </button>
            </div>
          )}
        </div>
        </div>
      }
    >
      {viewError && <p className="mt-2 rounded-lg bg-danger-soft px-2.5 py-1.5 text-xs text-danger">{viewError}</p>}
      {settingsOpen && (
        <PropertySettings
          fields={allRows.map((r) => ({ key: r.key, label: r.label }))}
          view={view}
          onSave={(v) => changeView(v, v.personal ? 'Column settings saved to your personal view.' : 'Back to the default view.')}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {searchOpen && (
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setQuery('');
              setSearchOpen(false);
            }
          }}
          placeholder="Search properties"
          aria-label="Search properties"
          className="mt-2.5 w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-ink outline-hidden placeholder:text-faint focus:border-primary focus:ring-1 focus:ring-primary"
        />
      )}
      <dl className="mt-1">
        {rows.map((row) => (
          <PropertyItem key={row.key} row={row} contactId={contact.id} editing={editing === row.key} onEdit={(on) => setEditing(on ? row.key : null)} onSaved={onSaved} />
        ))}
        {rows.length === 0 && <p className="py-3 text-xs text-faint">{query.trim() ? `No property matches “${query.trim()}”` : 'All properties are hidden in your view. Use ⋮ → Manage column settings.'}</p>}
      </dl>
    </Section>
  );
}

function PropertyItem({
  row,
  contactId,
  editing,
  onEdit,
  onSaved,
}: {
  row: PropertyRow;
  contactId: string;
  editing: boolean;
  onEdit: (on: boolean) => void;
  onSaved: (c: ContactProfile, label: string) => void;
}) {
  const [value, setValue] = useState(row.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!editing) setValue(row.value);
  }, [row.value, editing]);

  async function save(next = value) {
    if (busy) return;
    if (next.trim() === row.value.trim()) return onEdit(false);
    setBusy(true);
    setError('');
    try {
      // Custom properties have their own values; Subscriber is yes/no (true/false); everything else is text
      const c = row.custom
        ? await setCustomValue(contactId, row.custom.id, next)
        : await updateContact(contactId, { [row.key]: row.key === 'subscribed' ? next === 'true' : next });
      onEdit(false);
      onSaved(c, row.label);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const field = 'w-full rounded-lg border border-primary bg-surface px-2.5 py-1 text-xs text-ink outline-hidden ring-1 ring-primary disabled:opacity-60';
  // Editable fields: hovering the field shows a pencil on the right; clicking the field (or the pencil) edits it
  const canStartEdit = row.editable && !editing;
  return (
    <div
      className={`group relative py-2 ${canStartEdit ? 'cursor-pointer pr-9' : ''}`}
      onClick={canStartEdit ? () => onEdit(true) : undefined}
    >
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted">{row.label}</dt>
      <dd className="mt-0.5">
        {editing && row.searchable ? (
          <div onClick={(e) => e.stopPropagation()}>
            <SearchSelect
              defaultOpen
              disabled={busy}
              label={row.label}
              value={value}
              options={row.options ?? []}
              filter={filterDialCountries}
              onChange={(v) => save(v)}
              onClose={() => !busy && onEdit(false)}
              placeholder={`Search ${row.label.toLowerCase()}`}
            />
          </div>
        ) : editing && row.kind === 'select' ? (
          <select autoFocus disabled={busy} value={value} onChange={(e) => save(e.target.value)} onBlur={() => !busy && onEdit(false)} onKeyDown={(e) => e.key === 'Escape' && onEdit(false)} className={`${field} cursor-pointer`}>
            {row.key !== 'subscribed' && <option value="">–</option>}
            {row.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : editing && row.inputType === 'multiline' ? (
          <textarea
            autoFocus
            rows={4}
            maxLength={2000}
            disabled={busy}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => save()}
            onKeyDown={(e) => {
              // Enter = new line; ⌘/Ctrl+Enter saves
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
              if (e.key === 'Escape') {
                setValue(row.value);
                setError('');
                onEdit(false);
              }
            }}
            className={`${field} resize-y`}
          />
        ) : editing ? (
          <input
            autoFocus
            type={row.kind === 'email' ? 'email' : row.inputType === 'multiline' ? 'text' : (row.inputType ?? 'text')}
            disabled={busy}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => save()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') {
                setValue(row.value);
                setError('');
                onEdit(false);
              }
            }}
            className={field}
          />
        ) : row.editable ? (
          <button
            type="button"
            title={`Edit ${row.label.toLowerCase()}`}
            onClick={(e) => {
              e.stopPropagation();
              onEdit(true);
            }}
            className={`block w-full py-0.5 text-left text-[13px] text-ink outline-hidden ${row.inputType === 'multiline' ? 'line-clamp-4 whitespace-pre-line break-words' : 'truncate'}`}
          >
            {displayValue(row)}
          </button>
        ) : (
          <p className="truncate py-0.5 text-[13px] text-ink">{displayValue(row)}</p>
        )}
        {error && <p className="mt-1 text-[11px] text-danger">{error}</p>}
      </dd>
      {canStartEdit && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-body-soft opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
          </svg>
        </span>
      )}
    </div>
  );
}

// Attachments: files sent in this chat, in two sections (Media, Document), newest first. WhatsApp media isn't
// downloaded yet, so each entry shows what was sent and when; the file itself can't be opened from here.
export function Files({ conversationId, contactId }: { conversationId: string; contactId: string }) {
  const [files, setFiles] = useState<ChatFile[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    setError('');
    fetchChatFiles(conversationId)
      .then((f) => !cancelled && setFiles(f))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  if (error) return <p className="mx-5 mt-4 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>;
  const { media, documents } = splitFiles(files ?? []);
  return (
    <>
      <FileSection
        title="Media"
        href={`/contacts/${encodeURIComponent(contactId)}?tab=media&type=all`}
        files={files && media}
        emptyTitle="No media here"
        emptyText="Photos, videos and voice messages shared by this contact will appear here."
      />
      <FileSection
        title="Document"
        href={`/contacts/${encodeURIComponent(contactId)}?tab=media&type=document`}
        files={files && documents}
        emptyTitle="No documents here"
        emptyText="Documents shared by this contact, such as PDFs or files, will appear here."
      />
    </>
  );
}

// Header (title, count, ›) opens the contact details page on its Media tab (filtered for Document); the files
// stay listed below
function FileSection({ title, href, files, emptyTitle, emptyText }: { title: string; href: string; files: ChatFile[] | null; emptyTitle: string; emptyText: string }) {
  const [viewing, setViewing] = useState<ChatFile | null>(null);
  return (
    <section className="border-b border-line-soft">
      <Link href={href} title={`Open ${title.toLowerCase()} in View contact details`} className="flex w-full items-center justify-between px-5 py-4 text-left hover:bg-surface-muted/60">
        <span className="text-[13px] font-semibold text-ink">{title}</span>
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
          {files === null ? '…' : files.length}
          <svg className="h-4 w-4 text-body-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </span>
      </Link>
      {(files === null ? (
          <p className="px-5 pb-4 text-xs text-faint">Loading…</p>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center px-8 pb-5 text-center">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-strong text-body-soft">
              <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                <path d="M14 3v5h5" />
                <circle cx="11.5" cy="14.5" r="2.5" />
                <path d="m13.5 16.5 2 2" />
              </svg>
            </span>
            <p className="mt-2.5 text-[13px] font-bold text-ink">{emptyTitle}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">{emptyText}</p>
          </div>
        ) : (
          <ul className="px-3 pb-3">
            {files.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  disabled={!f.available}
                  onClick={() => (f.type === 'document' ? downloadFile(f.id, f.mediaName || 'document').catch(() => {}) : setViewing(f))}
                  title={f.available ? (f.type === 'document' ? 'Download' : 'Open') : 'Not available'}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-surface-muted disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-strong text-body-soft">
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      {TAB_ICONS.files}
                    </svg>
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] text-ink">{f.mediaName || fileLabel(f.type)}</span>
                    <span className="block text-[11px] text-muted">
                      {f.direction === 'in' ? 'From the customer' : 'From your team'} · {formatDateTime(f.createdAt)}
                      {!f.available && ' · not available'}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ))}
      {viewing && <MediaViewer file={viewing} onClose={() => setViewing(null)} />}
    </section>
  );
}

// Orders tab: "Stripe payment status". Stripe isn't connected yet, so the list is empty (no made-up payments);
// the status dropdown and search work on the real payments once they come in.
const payments: Payment[] = [];
function Payments() {
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState<string>('all');
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const shown = filterPayments(payments, status, query);
  return (
    <section className="border-b border-line-soft px-5 py-4">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 text-[13px] font-semibold text-ink">
        <svg className={`h-3 w-3 text-body-soft transition-transform ${open ? '' : '-rotate-90'}`} viewBox="0 0 24 24" fill="currentColor">
          <path d="M6 9h12l-6 7z" />
        </svg>
        Stripe payment status
      </button>
      {open && (
        <>
          <div className="mt-3 flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                aria-label="Payment status"
                className="w-full cursor-pointer appearance-none rounded-full border border-line bg-surface py-1.5 pl-3.5 pr-8 text-xs text-body outline-hidden hover:border-line-strong focus:border-primary"
              >
                {PAYMENT_FILTERS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
              <svg className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-body-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </div>
            <button
              type="button"
              title="Search payments"
              aria-label="Search payments"
              aria-pressed={searchOpen}
              onClick={() => {
                const next = !searchOpen;
                setSearchOpen(next);
                if (!next) setQuery('');
                else setTimeout(() => searchRef.current?.focus(), 0);
              }}
              className={`${iconButton} ${searchOpen ? 'text-primary' : ''}`}
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </button>
          </div>
          {searchOpen && (
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setQuery('');
                  setSearchOpen(false);
                }
              }}
              placeholder="Search by payment ID, amount or description"
              aria-label="Search payments"
              className="mt-2 w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-ink outline-hidden placeholder:text-faint focus:border-primary focus:ring-1 focus:ring-primary"
            />
          )}
          {shown.length === 0 ? (
            <div className="flex flex-col items-center px-4 pt-5 pb-1 text-center">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-strong text-body-soft">
                <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                  <path d="M14 3v5h5" />
                  <circle cx="11.5" cy="14.5" r="2.5" />
                  <path d="m13.5 16.5 2 2" />
                </svg>
              </span>
              <p className="mt-2.5 text-[13px] font-bold text-ink">No results found</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">We couldn&apos;t find what you&apos;re looking for. Try searching again.</p>
              {payments.length === 0 && <p className="mt-2 text-[11px] text-faint">Stripe isn&apos;t connected to this workspace yet.</p>}
            </div>
          ) : (
            <ul className="mt-3 space-y-2">
              {shown.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 rounded-lg bg-surface-muted px-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-xs text-ink">{p.description || p.id}</span>
                    <span className="block text-[11px] text-muted">{formatDateTime(p.createdAt)}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-xs font-semibold text-ink">
                      {(p.amount / 100).toFixed(2)} {p.currency.toUpperCase()}
                    </span>
                    <span className="block text-[11px] capitalize text-muted">{p.status}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
