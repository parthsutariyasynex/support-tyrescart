'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createPortal } from 'react-dom';
import { type Socket, io } from 'socket.io-client';
import { API_URL, errorCode, getToken, isNetworkError } from '@/lib/api';
import {
  type Conversation,
  type ConversationStatus,
  type Message,
  deleteMessage,
  editMessage,
  reactToMessage,
  fetchConversation,
  fetchConversationCounts,
  fetchConversations,
  isAssignedTo,
  isNewLead,
  fetchMessages,
  markConversationRead,
  matchesSearch,
  needsAttention,
  newerMessage,
  clearConversation,
  restoreMessage,
  setConversationStatus,
  sendTextMessage,
  simulateIncomingMessage,
  snoozeConversation,
  setConversationPinned,
  markConversationUnread,
} from '@/lib/inbox';
import {
  type Activity,
  type NotificationFeed,
  activityText,
  fetchConversationActivity,
  fetchNotifications,
  fetchUnreadTotal,
  inBell,
  markNotificationsSeen,
} from '@/lib/activity';
import { type Assignee, type WorkspaceMember, claimConversation, fetchAssignees, fetchWorkspaceMembers } from '@/lib/assignees';
import { type Label, type Permissions, fetchLabels, fetchPermissions } from '@/lib/labels';
import { EMPTY_MENU_FILTERS, type MenuFilters, matchesMenuFilters, toServerFilter } from '@/lib/chatFilters';
import { findMessageMatches } from '@/lib/messageSearch';
import { bindPresence, presenceOf, usePresence } from '@/lib/presence';
import { revalidateOnReturn } from '@/lib/revalidate';
import { showsAssignCheckboxes } from '@/lib/roles';
import { AppShell, OPEN_CHAT_EVENT } from '../AppShell';
import { pinText, showToast } from '@/lib/toasts';
import { CONTACT_LISTS_EVENT, CONTACT_REMARKS_EVENT, CONTACT_UPDATED_EVENT, ContactPanel } from './ContactPanel';
import { EmojiPicker, FileSendDialog } from './composerExtras';
import { FormatToolbar } from './FormatToolbar';
import { ComposerHighlight } from './ComposerHighlight';
import { resumeMyLiveLocations, setLive, startWatching, stopSharing, useMyActiveLives } from '@/lib/liveSharing';
import type { LiveLocation } from '@/lib/location';
import { VoiceRecorder } from './voice';
import { StageFilterBar, StageMenu, StagePill } from './StageMenu';
import { TemplateComposer, TemplatePicker } from './templates';
import type { Template } from '@/lib/templates';
import { sendVoice } from '@/lib/voice';
import { insertAt } from '@/lib/emojis';
import { ACCEPT, checkFile, documentLabel, filePreview, formatSize, pastedName, sendFile } from '@/lib/media';
import { CONTACT_LIST_DELETED_EVENT, CONTACT_LIST_SAVED_EVENT } from './ListsDropdown';
import { CUSTOM_PROPERTIES_EVENT, type ContactRemark, NOTE_FILES_MAX, type StagesChanged, addRemark, fetchChatNotes, stagesChanged, uploadRemarkFile } from '@/lib/contacts';
import { PresenceDot } from '../PresenceDot';
import { AssignDropdown, AssigneeAvatar } from './assign';
import { CollaboratorsButton } from './CollaboratorsButton';
import { FilterMenu } from './FilterMenu';
import { type StatusFilter, StatusMenu } from './StatusMenu';
import { QuickReplyMenu, useQuickReplies } from './quickReplies';
import { type QuickReply, slashQuery } from '@/lib/quickReplies';
import { enterAction, fitHeight } from '@/lib/composer';
import { type Edit, type InlineStyle, type LineStyle, shortcutStyle, toggleInline, toggleLines } from '@/lib/formatting';
import { dayKey, dayLabel, formatDateTime, formatTime, listTimestamp } from '@/lib/time';
import { ContactAvatar, contactDisplayName } from './avatar';
import { ChatOptionsMenu, ClearIcon, CloseIcon, ConfirmClearDialog, PinIcon, SnoozeIcon, UnreadIcon } from './chatOptions';
import { snoozeChoices, snoozedUntilText } from '@/lib/snooze';
import { LabelChips, LabelPicker, TagIcon } from './labels';
import { NotificationBell, unlockSound } from './notifications';
import { setOpenConversationId } from '@/lib/desktopNotifications';
import { dismissChatPopups } from '@/lib/messagePopups';
import { isWindowClosedError, lastCustomerMessageAt, msUntilClose, windowOpen } from '@/lib/messagingWindow';
import { OVERLAY_SELECTOR, type EscapeTarget, escapeClosesChat } from '@/lib/escapeToClose';
import { CountryCodeMenu } from './CountryCodeMenu';
import { NewChatDialog } from './NewChatDialog';
import { NoteBubble } from './NoteBubble';
import { type MentionMember, MentionMenu } from './MentionMenu';
import { insertMention, matchMembers, mentionAt } from '@/lib/mentions';
import { WHATSAPP_TEXT_MAX, overLimit, tooLongText } from '@/lib/textLimits';
import {
  type TypingEvent,
  type TypingState,
  TypingDots,
  applyTypingEvent,
  pruneTyping,
  typingLabel,
  typingNames,
  useTypingSender,
} from './typing';
import {
  ConfirmDeleteDialog,
  DeletedText,
  MessageBubble,
  MessageMenu,
  type MessageAction,
  QuoteBlock,
  UndoToast,
  messageActions,
} from './messages';
import { ForwardDialog } from './ForwardDialog';

// The Location screen (📎 → Location): its map library loads only when it's opened
const LocationDialog = dynamic(() => import('./LocationDialog').then((m) => m.LocationDialog), { ssr: false });

const byLatest = (a: Conversation, b: Conversation) =>
  b.lastMessageAt.localeCompare(a.lastMessageAt) || b.id.localeCompare(a.id);

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

type LabelRef = Conversation['labels'][number];
// Which conversation the label picker is for (null = just manage labels) and the button it opened from
type PickerTarget = { conversationId: string | null; anchor: HTMLElement };


export default function InboxPage() {
  return <AppShell>{(me) => <Inbox meName={me.user.name} channelPhone={me.workspace.whatsapp?.displayPhone ?? null} defaultCountry={me.workspace.settings?.defaultCountry ?? ''} />}</AppShell>;
}

type ConversationFilter = { labelId: string | null; assignee: string | null; search: string | null; sort: SortOrder; status: 'open' | 'snoozed' | 'closed' | null; leadStage: string | null } & ReturnType<typeof toServerFilter>;
const filterKey = (f: ConversationFilter) => JSON.stringify(f);
type SortOrder = 'newest' | 'oldest';
type StatusChange = Pick<Conversation, 'status' | 'closedAt' | 'closedById'> & { conversationId: string; snoozedUntil?: string | null };

const SKEY_CONVOS = 'support:convos';
const SKEY_ACTIVE = 'support:activeChat';
const SKEY_LABELS = 'support:labels';
const SKEY_ASSIGNEES = 'support:assignees';
const SKEY_PERMS = 'support:permissions';
const SKEY_UNREAD = 'support:unreadTotal';
const SKEY_MSGS = 'support:messages';

function loadSessionJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveSessionJson(key: string, val: unknown) {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(key, JSON.stringify(val));
  } catch {}
}

// Ensure no stale filter keys from previous sessions remain in sessionStorage
if (typeof window !== 'undefined') {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && (k.startsWith('support:menuFilters') || k.startsWith('support:filterType') || k.startsWith('support:statusFilter') || k.startsWith('support:sortOrder'))) {
        sessionStorage.removeItem(k);
      }
    }
  } catch {}
}

function loadSessionMessages(): Map<string, { messages: Message[]; activity: Activity[]; cursor: string | null }> {
  const map = new Map<string, { messages: Message[]; activity: Activity[]; cursor: string | null }>();
  if (typeof window === 'undefined') return map;
  try {
    const raw = sessionStorage.getItem(SKEY_MSGS);
    if (raw) {
      const parsed: Record<string, { messages: Message[]; activity: Activity[]; cursor: string | null }> = JSON.parse(raw);
      for (const [k, v] of Object.entries(parsed)) {
        map.set(k, v);
      }
    }
  } catch {}
  return map;
}

function saveSessionMessages(map: Map<string, { messages: Message[]; activity: Activity[]; cursor: string | null }>) {
  if (typeof window === 'undefined') return;
  try {
    const obj: Record<string, unknown> = {};
    const entries = Array.from(map.entries()).slice(-10);
    for (const [k, v] of entries) {
      obj[k] = v;
    }
    sessionStorage.setItem(SKEY_MSGS, JSON.stringify(obj));
  } catch {}
}

// Module-level caches across client-side page transitions and browser reloads
let cachedConversationsByPath: Record<string, Conversation[]> = loadSessionJson(SKEY_CONVOS, {});
let cachedLabels: Label[] = loadSessionJson(SKEY_LABELS, []);
let cachedAssignees: Assignee[] = loadSessionJson(SKEY_ASSIGNEES, []);
let cachedPermissions: Permissions | null = loadSessionJson(SKEY_PERMS, null);
let cachedFeed: NotificationFeed | null = null;
let cachedUnreadTotal = loadSessionJson(SKEY_UNREAD, 0);
// Contact profile side panel: stays open (or closed) as you move between chats
// Remembered in this browser, so a refresh keeps it open (or closed). Read on first use: this page only renders after
// the app shell has loaded, so it never affects the server-rendered HTML.
const PROFILE_OPEN_KEY = 'support:profileOpen';
let cachedProfileOpen: boolean | null = null;
function readProfileOpen() {
  if (cachedProfileOpen !== null) return cachedProfileOpen;
  try {
    cachedProfileOpen = localStorage.getItem(PROFILE_OPEN_KEY) === 'true';
  } catch {
    cachedProfileOpen = false;
  }
  return cachedProfileOpen;
}
let cachedActiveIdByPath: Record<string, string | null> = loadSessionJson(SKEY_ACTIVE, {});
const messagesCache = loadSessionMessages();

function patchAllCachedConversations(fn: (c: Conversation) => Conversation) {
  for (const path of Object.keys(cachedConversationsByPath)) {
    cachedConversationsByPath[path] = cachedConversationsByPath[path].map(fn);
  }
  saveSessionJson(SKEY_CONVOS, cachedConversationsByPath);
}

function Inbox({ meName, channelPhone, defaultCountry }: { meName: string; channelPhone: string | null; defaultCountry: string }) {
  const pathname = usePathname();
  const mine = pathname === '/my-chats';
  const leads = pathname === '/leads';
  const collab = pathname === '/collaborations'; // chats I collaborate on
  const mentioned = pathname === '/mentions'; // chats where a teammate @mentioned me in a note

  const [conversations, setConversations] = useState<Conversation[]>(() => {
    if (cachedConversationsByPath[pathname]?.length) {
      return cachedConversationsByPath[pathname];
    }
    if (cachedConversationsByPath['/inbox']?.length) {
      if (pathname === '/leads') {
        return cachedConversationsByPath['/inbox'].filter(isNewLead);
      }
      const me = cachedPermissions; // a local so TypeScript keeps the null check inside the filter
      if (pathname === '/my-chats' && me) {
        return cachedConversationsByPath['/inbox'].filter((c) => isAssignedTo(c, me.userId));
      }
      if (pathname === '/inbox') {
        return cachedConversationsByPath['/inbox'];
      }
    }
    return [];
  });

  const [activeId, setActiveId] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      const urlId = new URLSearchParams(window.location.search).get('chat');
      if (urlId) {
        cachedActiveIdByPath[pathname] = urlId;
        saveSessionJson(SKEY_ACTIVE, cachedActiveIdByPath);
        return urlId;
      }
    }
    return cachedActiveIdByPath[pathname] ?? null;
  });
  // Tell the app shell which chat is on screen, so a desktop notification is skipped only for this one (every
  // other chat still alerts even while this page has focus); cleared when this page is left entirely.
  // TEMPORARY: console.debug logging while verifying the real-message notification flow end to end - remove once
  // confirmed working (matching logs in AppShell.tsx and inbox/notifications.tsx).
  useEffect(() => {
    setOpenConversationId(activeId);
    if (activeId) dismissChatPopups(activeId); // its new-message pop-up has been seen
    console.debug('[notify-debug] openConversationId set to', activeId, 'on', pathname);
  }, [activeId, pathname]);
  useEffect(
    () => () => {
      console.debug('[notify-debug] inbox page unmounting, clearing openConversationId');
      setOpenConversationId(null);
    },
    [],
  );

  const [messages, setMessages] = useState<Message[]>(() => {
    const urlId = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('chat') : null;
    const initId = urlId ?? cachedActiveIdByPath[pathname];
    if (initId && messagesCache.has(initId)) {
      return messagesCache.get(initId)!.messages;
    }
    return [];
  });

  const [messagesChatId, setMessagesChatId] = useState<string | null>(() => {
    const urlId = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('chat') : null;
    const initId = urlId ?? cachedActiveIdByPath[pathname];
    if (initId && messagesCache.has(initId)) {
      return initId;
    }
    return null;
  });

  const [olderCursor, setOlderCursor] = useState<string | null>(() => {
    const urlId = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('chat') : null;
    const initId = urlId ?? cachedActiveIdByPath[pathname];
    if (initId && messagesCache.has(initId)) {
      return messagesCache.get(initId)!.cursor;
    }
    return null;
  });

  const [conversationsCursor, setConversationsCursor] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [loading, setLoading] = useState(false);
  // Set only when the list failed to load and nothing is on screen for it (a background refresh failing while
  // chats are already showing stays silent — the on-screen list is still good, no need to alarm anyone over it)
  const [conversationsError, setConversationsError] = useState<string | null>(null);
  const [labels, setLabels] = useState<Label[]>(cachedLabels);
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  // AppShell's header slot for the bell and the Assign box. Resolved immediately if already in DOM, or via effect.
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(() => {
    if (typeof document === 'undefined') return null;
    return document.getElementById('app-header-actions');
  });
  const [assignees, setAssignees] = useState<Assignee[]>(cachedAssignees);
  const [membersVersion, setMembersVersion] = useState(0);
  const [permissions, setPermissions] = useState<Permissions | null>(cachedPermissions);
  const permissionsRef = useRef(permissions);
  // Toasts (assignment, new chat, reminders) are shown app-wide by AppShell from the shared store in lib/toasts
  const [profileOpen, setProfileOpenState] = useState(readProfileOpen);
  const setProfileOpen = useCallback((open: boolean) => {
    cachedProfileOpen = open;
    try {
      localStorage.setItem(PROFILE_OPEN_KEY, String(open));
    } catch {
      // private mode: just not remembered
    }
    setProfileOpenState(open);
  }, []);
  const [activity, setActivity] = useState<Activity[]>(() => {
    const urlId = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('chat') : null;
    const initId = urlId ?? cachedActiveIdByPath[pathname];
    if (initId && messagesCache.has(initId)) {
      return messagesCache.get(initId)!.activity;
    }
    return [];
  });
  const [feed, setFeed] = useState<NotificationFeed | null>(cachedFeed);
  const [unreadTotal, setUnreadTotal] = useState(cachedUnreadTotal);
  permissionsRef.current = permissions;
  const canManage = !!permissions?.canManageLabels;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  const labelFilter = filterType.startsWith('label:') ? filterType.slice(6) : null;
  const assigneeFilter = mine ? 'me' : leads ? 'new_leads' : collab ? 'collaborating' : mentioned ? 'mentioned' : filterType.startsWith('assigned:') ? filterType.slice(9) : null;
  // The search box: applied to the loaded chats at once; the server search (every message, label, name…) runs a
  // moment after you stop typing
  const [searchTerm, setSearchTerm] = useState('');
  // The search text the server has actually answered for (set when its list arrives). Until then, and whenever the
  // request fails, the loaded chats keep being filtered locally so the search never looks dead.
  const [serverSearchedTerm, setServerSearchedTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearchTerm(searchQuery.trim()), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);
  // Newest (latest activity first) or Oldest; the server sorts too, so paging follows the same order
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');
  // "Filter by" menu (labels, collaborator, date range); applied on the server and to live updates on screen
  const [menuFilters, setMenuFilters] = useState<MenuFilters>(EMPTY_MENU_FILTERS);
  // "● Open ⌄": All / Open / Closed (server-side too, so paging follows it)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const onSortOrderChange = useCallback((s: SortOrder) => {
    setSortOrder(s);
  }, []);

  const onMenuFiltersChange = useCallback((f: MenuFilters) => {
    setMenuFilters(f);
  }, []);

  const onStatusFilterChange = useCallback((s: StatusFilter) => {
    setStatusFilter(s);
  }, []);

  const onFilterTypeChange = useCallback((f: string) => {
    setFilterType(f);
  }, []);

  // Left menu → Lifecycle stages: ?stage=<value> shows only the chats whose customer is at that stage
  const searchParams = useSearchParams();
  const stageFilter = searchParams.get('stage') || null;
  const menuFilterKey = JSON.stringify(menuFilters);
  const currentFilter = (): ConversationFilter => ({ labelId: labelFilter, assignee: assigneeFilter, search: searchTerm || null, sort: sortOrder, status: statusFilter === 'all' ? null : statusFilter, leadStage: stageFilter, ...toServerFilter(menuFilters) });
  const filterRef = useRef<ConversationFilter>(currentFilter());
  filterRef.current = currentFilter();
  const lastActiveRef = useRef<Conversation | null>(null);

  const loadedMoreRef = useRef(false);
  const loadSeqRef = useRef(0);

  const updateConversations = useCallback((action: React.SetStateAction<Conversation[]>) => {
    setConversations((prev) => {
      const next = typeof action === 'function' ? action(prev) : action;
      cachedConversationsByPath[pathname] = next;
      saveSessionJson(SKEY_CONVOS, cachedConversationsByPath);
      return next;
    });
  }, [pathname]);

  const patchConversations = useCallback((fn: (c: Conversation) => Conversation) => {
    patchAllCachedConversations(fn);
    updateConversations((prev) => prev.map(fn));
    if (lastActiveRef.current) lastActiveRef.current = fn(lastActiveRef.current);
  }, [updateConversations]);

  const loadConversations = useCallback(() => {
    if (!cachedConversationsByPath[pathname]?.length) {
      setLoading(true);
    }
    const filter = filterRef.current;
    const seq = ++loadSeqRef.current;
    return fetchConversations(null, filter)
      .then((page) => {
        if (filterKey(filter) !== filterKey(filterRef.current)) return;
        if (seq !== loadSeqRef.current) return;
        setConversationsError(null);
        setServerSearchedTerm(filter.search ?? '');
        // A search result replaces the list outright (never merged with chats loaded earlier that no longer match)
        if (!loadedMoreRef.current || filter.search) {
          updateConversations(page.nodes);
          setConversationsCursor(page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null);
          return;
        }
        updateConversations((prev) => {
          const fresh = new Set(page.nodes.map((c) => c.id));
          return [...page.nodes, ...prev.filter((c) => !fresh.has(c.id))].sort(byLatest);
        });
      })
      .catch((err) => {
        if (filterKey(filter) !== filterKey(filterRef.current)) return;
        if (seq !== loadSeqRef.current) return;
        // Chats are already on screen: don't replace them with an error banner over a failed background refresh
        if (cachedConversationsByPath[pathname]?.length) return;
        setConversationsError(
          isNetworkError(err) ? (err as Error).message : (err as Error).message || 'Could not load conversations.',
        );
      })
      .finally(() => setLoading(false));
  }, [updateConversations, pathname]);

  const loadMoreConversations = useCallback(async () => {
    if (!conversationsCursor) return;
    setLoading(true);
    try {
      const filter = filterRef.current;
      const page = await fetchConversations(conversationsCursor, filter);
      if (filterKey(filter) !== filterKey(filterRef.current)) return;
      loadedMoreRef.current = true;
      updateConversations((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...page.nodes.filter((c) => !seen.has(c.id))];
      });
      setConversationsCursor(page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [conversationsCursor, updateConversations]);

  const loadLabels = useCallback(() => {
    fetchLabels()
      .then((l) => {
        cachedLabels = l;
        saveSessionJson(SKEY_LABELS, l);
        setLabels(l);
      })
      .catch(() => {});
  }, []);


  // Shared by the label picker (own changes) and Socket.IO (changes from other agents)
  const onConversationLabels = useCallback(
    (conversationId: string, next: LabelRef[]) => {
      patchConversations((c) => (c.id === conversationId ? { ...c, labels: next } : c));
      loadLabels(); // counts changed
      if (filterRef.current.labelId) loadConversations(); // may have joined the filtered list
    },
    [patchConversations, loadLabels, loadConversations],
  );

  const onLabelSaved = useCallback(
    (label: Label) => {
      setLabels((prev) => [...prev.filter((l) => l.id !== label.id), label].sort(byName));
      patchConversations((c) =>
        c.labels.some((l) => l.id === label.id)
          ? {
              ...c,
              labels: c.labels
                .map((l) => (l.id === label.id ? { id: label.id, name: label.name, color: label.color } : l))
                .sort(byName),
            }
          : c,
      );
    },
    [patchConversations],
  );

  const onLabelDeleted = useCallback(
    (id: string) => {
      setLabels((prev) => prev.filter((l) => l.id !== id));
      patchConversations((c) => ({ ...c, labels: c.labels.filter((l) => l.id !== id) }));
      setFilterType((f) => (f === `label:${id}` ? 'all' : f));
    },
    [patchConversations],
  );

  // Counts change often; only the most recently started fetch may update them, so a slow older reply can't win
  const assigneesSeqRef = useRef(0);
  const assigneesLoadedRef = useRef(false);
  const loadAssignees = useCallback(() => {
    const seq = ++assigneesSeqRef.current;
    fetchAssignees()
      .then((list) => {
        if (seq !== assigneesSeqRef.current) return;
        assigneesLoadedRef.current = true;
        cachedAssignees = list;
        saveSessionJson(SKEY_ASSIGNEES, list);
        setAssignees(list);
      })
      .catch(() => {});
  }, []);

  // Shared by the Assign dropdown (own changes) and Socket.IO (changes from other agents).
  // Your own change arrives twice (the reply and its socket echo); only the first one does anything.
  const onAssigned = useCallback(
    (conversationId: string, assignee: Conversation['assignee']) => {
      const ref = assignee && { id: assignee.id, name: assignee.name, color: assignee.color, userId: assignee.userId ?? null };
      const known =
        conversationsRef.current.find((c) => c.id === conversationId) ??
        (lastActiveRef.current?.id === conversationId ? lastActiveRef.current : undefined);
      if (known && (known.assignee?.id ?? null) === (ref?.id ?? null)) return;
      // A new assignment is unopened (bold for the assignee) unless they are looking at the chat right now
      const openedNow = !!ref && ref.userId === permissionsRef.current?.userId && conversationId === activeIdRef.current;
      // (wasAssigned follows the server's flag: the chat's assignment history)
      patchConversations((c) =>
        c.id === conversationId ? { ...c, assignee: ref, assigneeOpenedAt: openedNow ? new Date().toISOString() : null, wasAssigned: c.wasAssigned || !!ref } : c,
      );
      loadAssignees(); // counts changed
      if (filterRef.current.assignee) loadConversations(); // may have joined the filtered list
    },
    [patchConversations, loadAssignees, loadConversations],
  );

  const onAssigneeSaved = useCallback(
    (assignee: Assignee) => {
      setAssignees((prev) => {
        const next = [...prev.filter((a) => a.id !== assignee.id), assignee].sort(byName);
        cachedAssignees = next;
        return next;
      });
      patchConversations((c) =>
        c.assignee?.id === assignee.id
          ? { ...c, assignee: { id: assignee.id, name: assignee.name, color: assignee.color, userId: assignee.userId } }
          : c,
      );
      if (filterRef.current.assignee === 'me') loadConversations(); // linking may have changed what's "mine"
    },
    [patchConversations, loadConversations],
  );

  // The server unassigns their chats too
  const onAssigneeDeleted = useCallback(
    (id: string) => {
      setAssignees((prev) => {
        const next = prev.filter((a) => a.id !== id);
        cachedAssignees = next;
        return next;
      });
      patchConversations((c) => (c.assignee?.id === id ? { ...c, assignee: null } : c));
      setFilterType((f) => (f === `assigned:${id}` ? 'all' : f));
      if (filterRef.current.assignee === 'unassigned') loadConversations();
    },
    [patchConversations, loadConversations],
  );

  // An edit or delete, from this agent or (via Socket.IO) another one. Late or duplicate copies never win over newer ones.
  const onMessageUpdated = useCallback(
    (updated: Message) => {
      setMessages((prev) => prev.map((m) => (m.id === updated.id ? newerMessage(m, updated) : m)));
      patchConversations((c) =>
        c.lastMessage?.id === updated.id ? { ...c, lastMessage: newerMessage(c.lastMessage, updated) } : c,
      );
      for (const entry of messagesCache.values()) {
        entry.messages = entry.messages.map((m) => (m.id === updated.id ? newerMessage(m, updated) : m));
      }
    },
    [patchConversations],
  );

  // Closed or reopened here, or (via Socket.IO) by another agent. The chat stays in the list;
  // messages, labels and assignee are untouched.
  const onStatusChanged = useCallback(
    (change: StatusChange) => {
      const { conversationId, status, closedAt, closedById } = change;
      patchConversations((c) => (c.id === conversationId ? { ...c, status, closedAt, closedById, snoozedUntil: change.snoozedUntil ?? null } : c));
    },
    [patchConversations],
  );

  // Cleared (for this user only) here or in another of their tabs: empty the chat view and the list preview
  const onCleared = useCallback(
    (conversationId: string) => {
      messagesCache.delete(conversationId);
      saveSessionMessages(messagesCache);
      if (conversationId === activeIdRef.current) {
        setMessages([]);
        setActivity([]);
        setOlderCursor(null);
      }
      patchConversations((c) => (c.id === conversationId ? { ...c, lastMessage: null } : c));
    },
    [patchConversations],
  );

  // Clicking a closed chat in the list reopens it (there's no separate "Reopen chat" button)
  const [reopenError, setReopenError] = useState<{ id: string; message: string } | null>(null);
  const selectConversation = useCallback(
    (id: string) => {
      cachedActiveIdByPath[pathname] = id;
      saveSessionJson(SKEY_ACTIVE, cachedActiveIdByPath);
      setActiveId(id);
      setReopenError(null);
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href);
        if (url.searchParams.get('chat') !== id) {
          url.searchParams.set('chat', id);
          window.history.replaceState(null, '', url.toString());
        }
      }
      const c = conversations.find((x) => x.id === id);
      if (c?.status !== 'closed') return;
      setConversationStatus(id, 'open')
        .then((r) => onStatusChanged({ conversationId: r.id, status: r.status, closedAt: r.closedAt, closedById: r.closedById, snoozedUntil: r.snoozedUntil }))
        .catch((err) => setReopenError({ id, message: (err as Error).message }));
    },
    [conversations, onStatusChanged, pathname],
  );

  // The assignee linked to you, if any: "Assigned to me" is only offered when there is one
  const myAssignee = permissions ? (assignees.find((a) => a.userId === permissions.userId) ?? null) : null;
  // Only for the My Chats hint, never for filtering: an assignee with your name that isn't linked to anyone
  // (chats assigned to it aren't yours as far as the app knows; names aren't unique)
  const unlinkedNamesake = myAssignee
    ? null
    : (assignees.find((a) => !a.userId && a.name.trim().toLowerCase() === meName.trim().toLowerCase()) ?? null);
  // Your link was removed while "Assigned to me" was selected: fall back to All
  useEffect(() => {
    if (filterType === 'assigned:me' && permissions && assigneesLoadedRef.current && !myAssignee) setFilterType('all');
  }, [filterType, permissions, myAssignee]);

  // Changing the filter or the search starts over from the newest page
  useEffect(() => {
    loadedMoreRef.current = false;
    setConversationsCursor(null);
    loadConversations();
  }, [labelFilter, assigneeFilter, searchTerm, sortOrder, menuFilterKey, statusFilter, stageFilter, loadConversations]);

  // AppShell's top header leaves a slot for page controls. Look it up once this page is in the DOM (per path), and
  // if the header isn't rendered yet (first sign-in, before "me" loads) wait for it to appear.
  useEffect(() => {
    const find = () => {
      const el = document.getElementById('app-header-actions');
      if (el && document.contains(el)) {
        setHeaderSlot(el);
        return true;
      }
      setHeaderSlot(null);
      return false;
    };
    if (find()) return;
    const observer = new MutationObserver(() => {
      if (find()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [pathname]);

  // Synchronize state when switching tabs (/inbox, /my-chats, /leads, /collaborations)
  useEffect(() => {
    const cachedConvos = cachedConversationsByPath[pathname];
    if (cachedConvos && cachedConvos.length > 0) {
      setConversations(cachedConvos);
    }
    const targetActiveId = (typeof window !== 'undefined' ? new URL(window.location.href).searchParams.get('chat') : null) ?? cachedActiveIdByPath[pathname] ?? null;
    setActiveId(targetActiveId);
    setSortOrder('newest');
    setMenuFilters(EMPTY_MENU_FILTERS);
    setStatusFilter('all');
    setFilterType('all');
    setSearchQuery('');
  }, [pathname]);

  useEffect(() => {
    fetchPermissions()
      .then((p) => {
        cachedPermissions = p;
        saveSessionJson(SKEY_PERMS, p);
        setPermissions(p);
      })
      .catch(() => {});
  }, []);

  const loadFeed = useCallback(() => {
    fetchNotifications()
      .then((f) => {
        cachedFeed = f;
        setFeed(f);
      })
      .catch(() => {});
  }, []);
  const loadUnreadTotal = useCallback(() => {
    fetchUnreadTotal()
      .then((t) => {
        cachedUnreadTotal = t;
        saveSessionJson(SKEY_UNREAD, t);
        setUnreadTotal(t);
      })
      .catch(() => {});
  }, []);
  // "Unassigned (n)" in the filter: live count from the server (refreshed on every assignment change and new chat)
  const [unassignedCount, setUnassignedCount] = useState<number | null>(null);
  // Open / Closed counts for the status menu, from the same request
  const [statusCounts, setStatusCounts] = useState<{ open: number; snoozed: number; closed: number } | null>(null);
  const loadUnassignedCount = useCallback(() => {
    fetchConversationCounts()
      .then((c) => {
        setUnassignedCount(c.unassigned);
        setStatusCounts({ open: c.open, snoozed: c.snoozed, closed: c.closed });
      })
      .catch(() => {});
  }, []);

  // Open a chat from the bell or a desktop pop-up, even if it isn't in the loaded part of the list
  const openConversation = useCallback(
    (id: string) => {
      cachedActiveIdByPath[pathname] = id;
      saveSessionJson(SKEY_ACTIVE, cachedActiveIdByPath);
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href);
        if (url.searchParams.get('chat') !== id) {
          url.searchParams.set('chat', id);
          window.history.replaceState(null, '', url.toString());
        }
      }
      if (!conversationsRef.current.some((c) => c.id === id))
        fetchConversation(id)
          .then((c) => {
            lastActiveRef.current = c;
            setActiveId(id);
          })
          .catch(() => {});
      else setActiveId(id);
    },
    [pathname],
  );

  // A toast was clicked (AppShell): open that chat here
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id) openConversation(id);
    };
    window.addEventListener(OPEN_CHAT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_CHAT_EVENT, onOpen);
  }, [openConversation]);

  // Opened with ?chat=<id> (e.g. after "Assign to Me" moves a lead to My Chats): open that chat; with &profile=1
  // (the profile panel's "Open in a new tab") also open its contact profile
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('chat');
    if (id && params.get('profile') === '1') setProfileOpen(true);
    if (id) openConversation(id);
  }, [pathname, openConversation, setProfileOpen]);

  // "Assign to Me" on a New Lead. Only works while it's still unassigned (the server makes sure exactly one person
  // gets it); then it's yours and opens in My Chats. Nobody's role changes.
  const router = useRouter();
  const [claimError, setClaimError] = useState<{ id: string; message: string } | null>(null);
  const claim = useCallback(
    async (conversationId: string) => {
      setClaimError(null);
      try {
        const c = await claimConversation(conversationId);
        onAssigned(c.id, c.assignee);
        const known = conversationsRef.current.find((x) => x.id === c.id) ?? lastActiveRef.current;
        showToast(`claim:${c.id}`, c.id, 'You took this chat. It is now in your My Chats.', known?.contact ? known.contact.name || `+${known.contact.waId}` : '');
        router.push(`/my-chats?chat=${encodeURIComponent(c.id)}`);
      } catch (err) {
        setClaimError({ id: conversationId, message: (err as Error).message });
        loadConversations(); // someone else took it: refresh
      }
    },
    [onAssigned, router, loadConversations],
  );

  // Unread customer messages in the browser tab title, e.g. "(3) Inbox"
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, '');
    document.title = unreadTotal > 0 ? `(${unreadTotal}) ${base}` : base;
  }, [unreadTotal]);
  useEffect(() => {
    return () => {
      document.title = document.title.replace(/^\(\d+\) /, '');
    };
  }, []);

  // Sound needs one user interaction before browsers allow it
  useEffect(() => {
    const unlock = () => unlockSound();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  // Who else is typing where (other agents only; WhatsApp doesn't report customers typing)
  const [typing, setTyping] = useState<TypingState>({});
  const socketRef = useRef<Socket | null>(null);
  const sendTyping = useCallback((conversationId: string, isTyping: boolean) => {
    socketRef.current?.emit('typing', { conversationId, typing: isTyping });
  }, []);
  useEffect(() => {
    const t = setInterval(() => setTyping((s) => pruneTyping(s)), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    loadLabels();
    loadAssignees();
    loadFeed();
    loadUnreadTotal();
    loadUnassignedCount();
    const socket = io(API_URL, { auth: { token: getToken() } });
    socketRef.current = socket;
    const unbindPresence = bindPresence(socket); // online / away / offline dots
    // Coming back to this browser tab, or the connection re-establishing: pull what may have been missed
    const stopRevalidate = revalidateOnReturn(() => {
      loadConversations();
      loadLabels();
      loadAssignees();
      loadFeed();
      loadUnreadTotal();
      loadUnassignedCount();
    }, socket);
    socket.on('typing', (e: TypingEvent) => {
      if (e.userId === permissionsRef.current?.userId) return; // yourself in another tab
      setTyping((s) => applyTypingEvent(s, e));
    });
    // Someone started a chat with a new number: it appears in everyone's list at once
    // Mentioned in a note: the chat joins your Mentions list at once
    socket.on('mention:you', () => {
      if (filterRef.current.assignee === 'mentioned') loadConversations();
    });
    // A note that mentioned you was edited or deleted: your Mentions list and bell follow
    socket.on('mentions:changed', () => {
      if (filterRef.current.assignee === 'mentioned') loadConversations();
      loadFeed();
    });
    socket.on('conversation:started', () => {
      loadConversations();
      loadUnassignedCount();
    });
    socket.on('message:new', ({ conversation, message }: { conversation: Conversation; message: Message }) => {
      // The 24-hour window follows the server's lastInboundAt (Meta's time of the customer's message) at once
      if (conversation?.id && conversation.lastInboundAt !== undefined)
        patchConversations((c) => (c.id === conversation.id && c.lastInboundAt !== conversation.lastInboundAt ? { ...c, lastInboundAt: conversation.lastInboundAt } : c));
      if (message.conversationId === activeIdRef.current)
        setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
      loadConversations();
      loadUnreadTotal();
      loadUnassignedCount(); // a brand-new chat arrives unassigned
      // (the sound and desktop pop-up for a customer's message come from the app shell, on every page)
    });
    // Timeline of the open chat: every event in the workspace
    socket.on('activity:new', (a: Activity) => {
      if (a.conversationId && a.conversationId === activeIdRef.current && a.type !== 'message_received')
        setActivity((prev) => (prev.some((x) => x.id === a.id) ? prev : [...prev, a]));
    });
    // Bell: only what the server decided this person may see (admins everything, others their own chats)
    socket.on('notification:new', (a: Activity) => {
      if (!inBell(a)) return; // customer messages: desktop notifications, not the bell
      if (a.actorId === null || a.actorId !== permissionsRef.current?.userId)
        setFeed((f) => (f && !f.items.some((x) => x.id === a.id) ? { unseen: f.unseen + 1, items: [a, ...f.items].slice(0, 30) } : f));
    });
    socket.on('conversation:status', (change: StatusChange) => {
      onStatusChanged(change);
      loadUnassignedCount(); // Open / Closed counts
      // may have joined the Open / Closed list, or New Leads (a never-assigned chat waking up from snooze or reopened)
      if (filterRef.current.status || filterRef.current.assignee === 'new_leads') loadConversations();
    });
    socket.on('conversation:cleared', ({ conversationId, userId }: { conversationId: string; userId: string }) => {
      if (userId === permissionsRef.current?.userId) onCleared(conversationId);
    });
    // A live location started, moved, stopped or ended: its card and the "you're sharing" bar follow
    socket.on('live:changed', (live: LiveLocation) => setLive(live));
    // Live locations you were sharing before a reload carry on from this tab
    void resumeMyLiveLocations();
    socket.on('message:status', (updated: Message) =>
      setMessages((prev) => prev.map((m) => (m.id === updated.id ? newerMessage(m, updated) : m))),
    );
    socket.on('message:updated', onMessageUpdated);
    socket.on('label:saved', onLabelSaved);
    socket.on('label:deleted', ({ id }: { id: string }) => onLabelDeleted(id));
    socket.on('conversation:labels', ({ conversationId, labels }: { conversationId: string; labels: LabelRef[] }) =>
      onConversationLabels(conversationId, labels),
    );
    socket.on(
      'conversation:assigned',
      ({ conversationId, assignee }: { conversationId: string; assignee: Conversation['assignee'] }) => {
        onAssigned(conversationId, assignee);
        loadUnassignedCount();
      },
    );
    // Assigned to you while you're looking at it: tell the server it is opened, so reminders don't start for it.
    // (The toast, sound and desktop pop-up for assignment events and reminders come from AppShell, on every page.)
    socket.on('assignment:you', ({ conversationId }: { conversationId: string }) => {
      if (conversationId === activeIdRef.current) markConversationRead(conversationId).catch(() => {});
    });
    // Contact profile edited or remarks changed (by anyone): the open profile panel follows
    socket.on('contact:updated', (c: { id: string; leadStage?: string | null; country?: string | null }) => {
      window.dispatchEvent(new CustomEvent(CONTACT_UPDATED_EVENT, { detail: c }));
      // The chat header's stage follows (it reads the stage from the chat list)
      patchConversations((x) => (x.contact.id === c.id ? { ...x, contact: { ...x.contact, leadStage: c.leadStage ?? null, ...('country' in c ? { country: c.country ?? null } : {}) } } : x));
    });
    socket.on('contact:properties', () => window.dispatchEvent(new Event(CUSTOM_PROPERTIES_EVENT)));
    // A contact was deleted (admins): their chat leaves the list at once; restored: it comes back
    socket.on('contact:deleted', ({ conversationId }: { conversationId: string | null }) => {
      if (!conversationId) return;
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      if (activeIdRef.current === conversationId) setActiveId(null);
    });
    socket.on('contact:restored', () => loadConversations());
    // Stages edited in Settings → Customer lifecycle; a deleted stage moved its contacts (chat list pills follow)
    socket.on('leadStages:changed', (d: StagesChanged) => {
      stagesChanged(d ?? {});
      const moved = d?.moved;
      if (moved) patchConversations((x) => (x.contact.leadStage === moved.from ? { ...x, contact: { ...x.contact, leadStage: moved.to } } : x));
    });
    socket.on('contact:remarks', (e: { contactId: string }) => window.dispatchEvent(new CustomEvent(CONTACT_REMARKS_EVENT, { detail: e })));
    socket.on('contact:lists', (e: { contactId: string }) => window.dispatchEvent(new CustomEvent(CONTACT_LISTS_EVENT, { detail: e })));
    socket.on('contactList:saved', (l: { id: string }) => window.dispatchEvent(new CustomEvent(CONTACT_LIST_SAVED_EVENT, { detail: l })));
    socket.on('contactList:deleted', (l: { id: string }) => window.dispatchEvent(new CustomEvent(CONTACT_LIST_DELETED_EVENT, { detail: l })));
    // Pinned/unpinned in another of your tabs; "Mark as unread" by anyone
    socket.on('conversation:pinned', ({ conversationId, pinned }: { conversationId: string; pinned: boolean }) =>
      patchConversations((c) => (c.id === conversationId ? { ...c, pinned } : c)),
    );
    socket.on('conversation:unread', ({ conversationId, unread }: { conversationId: string; unread: number }) => {
      patchConversations((c) => (c.id === conversationId ? { ...c, unread: Math.max(c.unread, unread) } : c));
      loadUnreadTotal();
    });
    // Collaborators changed on a chat: am I one now? (Collaborations follows)
    socket.on('conversation:collaborators', ({ conversationId, collaborators }: { conversationId: string; collaborators: { id: string }[] }) => {
      const me = permissionsRef.current?.userId;
      const isCollaborator = !!me && collaborators.some((c) => c.id === me);
      patchConversations((c) => (c.id === conversationId ? { ...c, isCollaborator } : c));
      if (filterRef.current.assignee === 'collaborating') loadConversations(); // may have joined Collaborations
    });
    socket.on('assignee:saved', onAssigneeSaved);
    socket.on('assignee:deleted', ({ id }: { id: string }) => onAssigneeDeleted(id));
    // An owner/admin granted or removed this user's label-management permission
    socket.on('member:removed', () => {
      setMembersVersion((v) => v + 1);
      loadUnassignedCount(); // their chats were released
    });
    socket.on('member:permissions', ({ userId, role, canManageLabels, canManageAssignments }: Permissions) => {
      setMembersVersion((v) => v + 1);
      // e.g. an admin just granted (or removed) this supervisor's right to assign chats: applies without a reload
      if (userId === permissionsRef.current?.userId) setPermissions({ userId, role, canManageLabels, canManageAssignments });
      loadAssignees(); // a role or name change alters the assignee shape (colour, name) in the Assign list
    });
    return () => {
      stopRevalidate();
      unbindPresence();
      socketRef.current = null;
      socket.disconnect();
    };
  }, [
    loadConversations,
    loadLabels,
    loadAssignees,
    onLabelSaved,
    onLabelDeleted,
    onConversationLabels,
    onAssigned,
    onAssigneeSaved,
    onAssigneeDeleted,
    onMessageUpdated,
    onStatusChanged,
    loadUnreadTotal,
    openConversation,
    onCleared,
    loadUnassignedCount,
    loadFeed,
  ]);

  useEffect(() => {
    if (!activeId) {
      setMessagesChatId(null);
      return;
    }
    if (messagesCache.has(activeId)) {
      const cached = messagesCache.get(activeId)!;
      setMessages(cached.messages);
      setActivity(cached.activity);
      setOlderCursor(cached.cursor);
      setMessagesChatId(activeId);
    }
    let cancelled = false; // ignore late responses after switching chats
    setOlderCursor(null);
    // Opening it: no longer bold (unread, and an assignment of yours you hadn't opened; the server records both)
    patchConversations((c) =>
      c.id === activeId
        ? { ...c, unread: 0, ...(c.assignee?.userId === permissionsRef.current?.userId && !c.assigneeOpenedAt ? { assigneeOpenedAt: new Date().toISOString() } : {}) }
        : c,
    );
    Promise.all([
      fetchMessages(activeId),
      fetchConversationActivity(activeId),
      markConversationRead(activeId),
    ])
      .then(([page, activityItems]) => {
        if (cancelled) return;
        const cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
        messagesCache.set(activeId, {
          messages: page.nodes,
          activity: activityItems,
          cursor,
        });
        saveSessionMessages(messagesCache);
        setMessages(page.nodes);
        setActivity(activityItems);
        setOlderCursor(cursor);
        setMessagesChatId(activeId);
        loadUnreadTotal();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeId, patchConversations, loadUnreadTotal]);

  async function loadOlderMessages() {
    if (!activeId || !olderCursor) return;
    try {
      const page = await fetchMessages(activeId, olderCursor);
      const cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      setMessages((prev) => {
        const next = [...page.nodes.filter((m) => !prev.some((p) => p.id === m.id)), ...prev];
        const c = messagesCache.get(activeId);
        if (c) {
          c.messages = next;
          c.cursor = cursor;
          saveSessionMessages(messagesCache);
        }
        return next;
      });
      setOlderCursor(cursor);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  const listed = conversations.find((c) => c.id === activeId);
  if (listed) lastActiveRef.current = listed;
  const active = listed ?? (lastActiveRef.current?.id === activeId ? lastActiveRef.current : undefined);

  const filteredConversations = conversations
    .filter(listFilter)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (sortOrder === 'oldest' ? byLatest(b, a) : byLatest(a, b)));
  function listFilter(c: Conversation) {
    if (statusFilter !== 'all' && c.status !== statusFilter) return false;
    if (!matchesMenuFilters(c, menuFilters)) return false;
    if (stageFilter && c.contact.leadStage !== stageFilter) return false; // a stage change moves the chat in or out at once
    // Instant, on what is loaded; the server applies the same rule across all messages and refreshes the list.
    // While the server result for this exact text is in, chats it returned stay listed even if only an older
    // message matched (the local rule only sees the last one).
    const term = searchQuery.trim();
    const serverSearched = term !== '' && serverSearchedTerm === term && searchTerm === term;
    const matched = serverSearched || matchesSearch(c, searchQuery);
    // A chat reassigned away from you leaves My Chats at once (the socket update patches it before any refetch)
    // (Until your permissions load, the server's "me" filter alone decides, so My Chats doesn't flash empty)
    if (mine && permissions && !isAssignedTo(c, permissions.userId)) return false; // My Chats: assigned to me (collaborations are in Collaborations)
    if (collab && !c.isCollaborator) return false; // Collaborations: removed as a collaborator leaves at once
    if (leads && !isNewLead(c)) return false; // taken by someone, closed or snoozed: not a new lead
    // Unread = what shows bold: unread customer messages, or assigned to you and not opened yet (WhatsApp-style)
    if (filterType === 'unread') return matched && needsAttention(c, permissions?.userId);
    // Unreplied: the customer's message is the latest one (nobody has answered yet)
    if (filterType === 'unreplied') return matched && c.lastMessage?.direction === 'in' && !c.lastMessage.deletedAt;
    if (labelFilter) return matched && c.labels.some((l) => l.id === labelFilter);
    if (assigneeFilter === 'me') return matched && isAssignedTo(c, permissions?.userId);
    if (assigneeFilter === 'collaborating') return matched && c.isCollaborator;
    if (assigneeFilter === 'mentioned') return matched; // the server decides (who was mentioned in which note)
    if (assigneeFilter === 'unassigned') return matched && !c.assignee;
    if (assigneeFilter === 'new_leads') return matched; // New Leads: checked above
    if (assigneeFilter) return matched && c.assignee?.id === assigneeFilter;
    return matched;
  }

  const openPicker = (conversationId: string | null, anchor: HTMLElement) =>
    setPicker((p) => (p?.anchor === anchor ? null : { conversationId, anchor }));
  const pickerConversation = picker?.conversationId
    ? (conversations.find((c) => c.id === picker.conversationId) ??
      (active?.id === picker.conversationId ? active : undefined))
    : undefined;

  return (
    <div suppressHydrationWarning className="flex h-full w-full overflow-hidden">
      {/* Left Conversations List Panel */}
      <ConversationList
        conversations={filteredConversations}
        sortOrder={sortOrder}
        onSortChange={onSortOrderChange}
        statusFilter={statusFilter}
        onStatusFilterChange={onStatusFilterChange}
        statusCounts={statusCounts}
        menuFilters={menuFilters}
        onMenuFiltersChange={onMenuFiltersChange}
        totalCount={conversations.length}
        meId={permissions?.userId ?? null}
        unassignedCount={unassignedCount}
        activeId={activeId}
        onSelect={selectConversation}
        onRefresh={loadConversations}
        defaultCountry={defaultCountry}
        conversationsError={conversationsError}
        onLoadMore={conversationsCursor ? loadMoreConversations : undefined}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        filterType={filterType}
        onFilterChange={onFilterTypeChange}
        labels={labels}
        assignees={assignees}
        myAssignee={myAssignee}
        unlinkedNamesake={unlinkedNamesake}
        mine={mine}
        leads={leads}
        collab={collab}
        onClaim={claim}
        claimError={claimError}
        typing={typing}
        onOpenLabels={openPicker}
        pickerConversationId={picker?.conversationId}
        loading={loading}
        stageBar={
          stageFilter ? (
            <StageFilterBar
              value={stageFilter}
              onClear={() => {
                const url = new URL(window.location.href);
                url.searchParams.delete('stage');
                router.replace(`${url.pathname}${url.search}`, { scroll: false });
              }}
            />
          ) : null
        }
      />

      {/* Right Chat Panel with WhatsApp Doodle Background */}
      {active ? (
        <ChatPanel
          meName={meName}
          assignees={assignees}
          conversation={active}
          messages={messagesChatId === active.id ? messages : []}
          onLoadOlder={olderCursor ? loadOlderMessages : undefined}
          onSent={(m) => {
            setMessages((p) => {
              const next = p.some((x) => x.id === m.id) ? p : [...p, m];
              if (activeIdRef.current) {
                const c = messagesCache.get(activeIdRef.current);
                if (c) {
                  c.messages = next;
                  saveSessionMessages(messagesCache);
                }
              }
              return next;
            });
          }}
          onOpenLabels={(anchor) => openPicker(active.id, anchor)}
          viewer={permissions && { userId: permissions.userId, isAdmin: ['owner', 'admin'].includes(permissions.role), role: permissions.role }}
          onMessageUpdated={onMessageUpdated}
          onStatusChanged={onStatusChanged}
          onPinnedChanged={(id, pinned) => patchConversations((c) => (c.id === id ? { ...c, pinned } : c))}
          onMarkedUnread={(id, unread) => {
            patchConversations((c) => (c.id === id ? { ...c, unread } : c));
            loadUnreadTotal();
          }}
          onClosed={() => {
            cachedActiveIdByPath[pathname] = null;
            saveSessionJson(SKEY_ACTIVE, cachedActiveIdByPath);
            if (typeof window !== 'undefined') {
              const url = new URL(window.location.href);
              if (url.searchParams.has('chat')) {
                url.searchParams.delete('chat');
                window.history.replaceState(null, '', url.toString());
              }
            }
            setActiveId(null);
          }}
          onCleared={() => onCleared(active.id)}
          onClaim={() => claim(active.id)}
          claimError={claimError?.id === active.id ? claimError.message : null}
          reopenError={reopenError?.id === active.id ? reopenError.message : null}
          typingNames={typingNames(typing, active.id)}
          activity={messagesChatId === active.id ? activity : []}
          meId={permissions?.userId ?? null}
          onTyping={(isTyping) => sendTyping(active.id, isTyping)}
          profileOpen={profileOpen}
          onToggleProfile={() => setProfileOpen(!profileOpen)}
          onOpenProfile={() => setProfileOpen(true)}
          channelPhone={channelPhone}
        />
      ) : (
        <EmptyChatState />
      )}
      {active && profileOpen && (
        <ContactPanel
          conversation={active}
          viewer={permissions && { userId: permissions.userId, isAdmin: ['owner', 'admin'].includes(permissions.role) }}
          labels={labels}
          onConversationLabels={onConversationLabels}
          onOpenLabels={(anchor) => openPicker(active.id, anchor)}
          onClose={() => setProfileOpen(false)}
        />
      )}

      {headerSlot &&
        createPortal(
          <NotificationBell
            feed={feed}
            meId={permissions?.userId ?? null}
            onOpen={() => {
              setFeed((f) => (f ? { ...f, unseen: 0 } : f));
              markNotificationsSeen().catch(() => {});
            }}
            onSelect={openConversation}
          />,
          headerSlot,
        )}
      {headerSlot &&
        createPortal(
          <AssignDropdown
            conversation={active}
            assignees={assignees}
            meId={permissions?.userId ?? null}
            canAssignOthers={showsAssignCheckboxes(permissions)}
            membersVersion={membersVersion}
            onAssigned={onAssigned}
            onConfirmed={(conversationId, message) => {
              const c = conversationsRef.current.find((x) => x.id === conversationId) ?? lastActiveRef.current;
              showToast(`own:${conversationId}:${Date.now()}`, conversationId, message, c?.contact ? c.contact.name || `+${c.contact.waId}` : '');
            }}
          />,
          headerSlot,
        )}

      {picker && (picker.conversationId === null || pickerConversation) && (
        <LabelPicker
          key={`picker-${picker.conversationId}`}
          anchor={picker.anchor}
          conversation={pickerConversation}
          labels={labels}
          canManage={canManage}
          onClose={() => setPicker(null)}
          onLabelSaved={onLabelSaved}
          onLabelDeleted={onLabelDeleted}
          onConversationLabels={onConversationLabels}
        />
      )}

    </div>
  );
}

function ConversationList({
  conversations,
  totalCount,
  activeId,
  onSelect,
  onRefresh,
  defaultCountry,
  conversationsError,
  onLoadMore,
  searchQuery,
  sortOrder,
  onSortChange,
  statusFilter,
  onStatusFilterChange,
  statusCounts,
  menuFilters,
  onMenuFiltersChange,
  onSearchChange,
  filterType,
  onFilterChange,
  labels,
  assignees,
  myAssignee,
  unlinkedNamesake,
  mine,
  leads,
  collab,
  onClaim,
  claimError,
  onOpenLabels,
  pickerConversationId,
  loading,
  typing,
  meId,
  unassignedCount,
  stageBar,
}: {
  stageBar?: React.ReactNode; // the lifecycle stage being shown (left menu), with a way back to all chats
  conversations: Conversation[];
  totalCount: number;
  // Signed-in user: their unopened assignments show bold
  meId: string | null;
  // Live number of chats with no assignee, for the Unassigned option (null while loading)
  unassignedCount: number | null;
  activeId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  // The workspace's default phone country, preselected in New chat
  defaultCountry: string;
  // Set when the list failed to load and the screen has nothing to show for it; offers Retry instead of the usual
  // empty-state copy
  conversationsError?: string | null;
  onLoadMore?: () => void;
  searchQuery: string;
  sortOrder: SortOrder;
  onSortChange: (s: SortOrder) => void;
  statusFilter: StatusFilter;
  onStatusFilterChange: (s: StatusFilter) => void;
  statusCounts: { open: number; snoozed: number; closed: number } | null;
  menuFilters: MenuFilters;
  onMenuFiltersChange: (f: MenuFilters) => void;
  onSearchChange: (q: string) => void;
  filterType: string;
  onFilterChange: (f: string) => void;
  labels: Label[];
  assignees: Assignee[];
  myAssignee: Assignee | null;
  unlinkedNamesake: Assignee | null;
  mine: boolean;
  leads: boolean;
  // Collaborations page: only chats I collaborate on
  collab: boolean;
  onClaim: (conversationId: string) => void;
  claimError: { id: string; message: string } | null;
  onOpenLabels: (conversationId: string | null, anchor: HTMLElement) => void;
  pickerConversationId?: string | null;
  loading: boolean;
  typing: TypingState;
}) {
  const listContainerRef = useRef<HTMLDivElement>(null);
  const mentionsPage = usePathname() === '/mentions';
  const scrollKey = `support:scroll:list:${mine ? 'mine' : leads ? 'leads' : collab ? 'collab' : mentionsPage ? 'mentions' : 'inbox'}`;
  const restoredScrollRef = useRef<string | null>(null);

  useEffect(() => {
    const el = listContainerRef.current;
    if (!el) return;
    if (restoredScrollRef.current === scrollKey) return;
    if (conversations.length === 0) return;
    const saved = sessionStorage.getItem(scrollKey);
    if (saved !== null) {
      el.scrollTop = Number(saved);
      restoredScrollRef.current = scrollKey;
    }
  }, [scrollKey, conversations.length]);

  const onListScroll = useCallback(() => {
    const el = listContainerRef.current;
    if (el) {
      try {
        sessionStorage.setItem(scrollKey, String(el.scrollTop));
      } catch {}
    }
  }, [scrollKey]);

  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const presence = usePresence(); // online / away / offline dots next to assignees
  // New chat (dialog): a new number gets a chat; a number that already has one opens it (never a second contact)
  const [newChatOpen, setNewChatOpen] = useState(false);
  const newChat = () => setNewChatOpen(true);
  function onNewChat(c: Conversation, startedNow: boolean) {
    setNewChatOpen(false);
    onRefresh();
    onSelect(c.id);
    if (!startedNow) showToast(`existing:${c.id}:${Date.now()}`, c.id, 'This number already has a chat: opened it.', c.contact.name || `+${c.contact.waId}`);
  }

  async function simulate() {
    try {
      await simulateIncomingMessage();
      onRefresh();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  return (
    <section className="relative z-30 flex h-full min-h-0 w-72 sm:w-80 shrink-0 flex-col border-r border-line/90 bg-surface">
      {newChatOpen && <NewChatDialog defaultCountry={defaultCountry} onDone={onNewChat} onClose={() => setNewChatOpen(false)} />}
      {/* Top Header Metrics + Refresh Button */}
      <div className="flex shrink-0 items-center justify-between px-4 pt-3 pb-2 text-xs text-muted">
        <StatusMenu value={statusFilter} onChange={onStatusFilterChange} counts={statusCounts} />
        <div className="flex items-center gap-0.5">
            {/* Sort: Newest ⇄ Oldest (by last activity) */}
            <button
              type="button"
              onClick={() => onSortChange(sortOrder === 'newest' ? 'oldest' : 'newest')}
              title={sortOrder === 'newest' ? 'Newest first: click for oldest first' : 'Oldest first: click for newest first'}
              aria-label={`Sort: ${sortOrder === 'newest' ? 'Newest' : 'Oldest'} first`}
              className="flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-body-soft hover:bg-surface-strong"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m3 16 4 4 4-4" />
                <path d="M7 20V4" />
                <path d="m21 8-4-4-4 4" />
                <path d="M17 4v16" />
              </svg>
              {sortOrder === 'newest' ? 'Newest' : 'Oldest'}
            </button>
            <button
              type="button"
              title="New chat"
              aria-label="New chat"
              onClick={newChat}
              className="flex h-6 w-6 items-center justify-center rounded-full text-body-soft transition hover:bg-surface-strong hover:text-primary"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            {/* Search: hidden until the icon is clicked (stays open while a search is active) */}
            <button
              type="button"
              title="Search chats"
              aria-label="Search chats"
              aria-expanded={searchOpen}
              onClick={() => {
                if (searchOpen && !searchQuery) setSearchOpen(false);
                else {
                  setSearchOpen(true);
                  requestAnimationFrame(() => searchInputRef.current?.focus());
                }
              }}
              className={`flex h-6 w-6 items-center justify-center rounded-full transition hover:bg-surface-strong ${searchOpen || searchQuery ? 'text-primary' : 'text-body-soft'}`}
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </button>
            <FilterMenu value={menuFilters} onChange={onMenuFiltersChange} labels={labels} assignees={assignees} />
        </div>
      </div>

      {/* Search Input (opened from the 🔍 icon above) */}
      {(searchOpen || searchQuery) && (
      <div className="shrink-0 px-3 py-1">
        <div className="relative">
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                onSearchChange('');
                setSearchOpen(false);
              }
            }}
            placeholder="Search"
            title="Finds chats by customer name, phone number, any message text, label, assignee, or the words open / closed / unread / unassigned"
            className="w-full rounded-lg border border-line bg-surface-muted/70 px-3 py-1.5 text-xs text-ink-soft placeholder:text-faint outline-hidden transition hover:bg-surface focus:border-primary focus:bg-surface focus:ring-1 focus:ring-primary"
          />
          <button
            type="button"
            title="Close search"
            aria-label="Close search"
            onClick={() => {
              onSearchChange('');
              setSearchOpen(false);
            }}
            className="absolute inset-y-0 right-0 pr-2 flex items-center text-faint hover:text-body-soft text-xs"
          >
            ✕
          </button>
        </div>
      </div>
      )}

      {/* Quick filters: All · Unread · Unreplied (sticky at the top of the chat list) */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line-soft px-3 pb-2 pt-0.5">
        {(
          [
            ['all', 'All'],
            ['unread', 'Unread'],
            ['unreplied', 'Unreplied'],
          ] as const
        ).map(([value, label]) => {
          const active = filterType === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={active}
              onClick={() => onFilterChange(value)}
              className={`rounded-full border px-3 py-1 text-[11px] font-medium transition ${
                active ? 'border-primary/40 bg-primary-subtle text-primary' : 'border-transparent bg-surface-muted text-body-soft hover:bg-surface-strong'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>


      {stageBar}
      {/* Conversation List / Empty State */}
      <div ref={listContainerRef} onScroll={onListScroll} className="flex-1 min-h-0 overflow-y-auto" style={{ scrollbarGutter: 'stable' }}>
        {conversations.length === 0 && conversationsError ? (
          <div className="flex flex-col items-start gap-2.5 p-5 text-xs leading-relaxed text-muted">
            <p className="text-danger">{conversationsError}</p>
            <button
              onClick={onRefresh}
              className="rounded-full border border-line bg-surface px-3 py-1.5 text-[11px] font-semibold text-body shadow-2xs hover:bg-surface-muted transition cursor-pointer"
            >
              Retry
            </button>
          </div>
        ) : conversations.length === 0 && filterType !== 'all' ? (
          <p className="p-5 text-xs leading-relaxed text-muted">No conversations match this filter.</p>
        ) : conversations.length === 0 && leads ? (
          <p className="p-5 text-xs leading-relaxed text-muted">
            No new leads right now. New customer chats that nobody has taken yet appear here.
          </p>
        ) : conversations.length === 0 && collab ? (
          <div className="p-4 text-xs text-muted">No collaborations yet. Chats you are added to as a collaborator will appear here.</div>
        ) : conversations.length === 0 && mentionsPage ? (
          <div className="p-4 text-xs text-muted">No mentions yet. Chats where a teammate @mentions you in an internal note will appear here.</div>
        ) : conversations.length === 0 && mine ? (
          <div className="space-y-2 p-5 text-xs leading-relaxed text-muted">
            <p>
              {myAssignee
                ? 'No chats are assigned to you right now. Chats assigned to you, or that you are added to as a collaborator, will appear here.'
                : "No chats are assigned to you yet. When someone assigns you a chat from the Assign menu (under People), it appears here."}
            </p>
            {unlinkedNamesake && (
              <p className="rounded-lg bg-warning-soft px-3 py-2 text-warning">
                &ldquo;{unlinkedNamesake.name}&rdquo; is a name-only assignee that isn&apos;t linked to your account, so chats
                assigned to it don&apos;t show here. To link it, an admin opens Assign, clicks ✏️ next to &ldquo;
                {unlinkedNamesake.name}&rdquo; and sets Linked user to you.
              </p>
            )}
          </div>
        ) : conversations.length === 0 ? (
          <div className="p-5 text-left">
            <p className="text-xs leading-relaxed text-muted font-normal">
              No conversations yet. Once a customer messages your number, they will appear here.
            </p>

            {/* Quick Helper Actions */}
            <div className="mt-6 flex flex-col gap-2">
              <button
                onClick={newChat}
                className="w-full rounded-lg bg-secondary py-2 px-3 text-xs font-semibold text-on-primary shadow-2xs hover:bg-secondary-hover transition flex items-center justify-center gap-1.5"
              >
                <span>+</span> Start a conversation
              </button>
              {/* {process.env.NODE_ENV !== 'production' && (
                <button
                  onClick={simulate}
                  className="w-full rounded-lg border border-dashed border-line-strong bg-surface-muted/50 py-1.5 px-3 text-xs text-body-soft hover:bg-surface-strong transition"
                >
                  ⚡ Simulate incoming message (dev)
                </button>
              )} */}
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-line-soft">
            {leads && claimError && (
              <li className="bg-danger-soft px-3.5 py-2 text-[11px] text-danger">{claimError.message}</li>
            )}
            {conversations.map((c) => {
              const contactName = contactDisplayName(c.contact);
              const isSelected = activeId === c.id;
              // WhatsApp-style: bold while there are unread messages or it was assigned to you and not opened yet
              const attention = needsAttention(c, meId);

              return (
                <li key={c.id} className="group relative">
                  <button
                    onClick={() => onSelect(c.id)}
                    className={`flex w-full items-start gap-3 px-3.5 py-3 text-left transition ${
                      isSelected ? 'bg-primary-subtle' : 'hover:bg-surface-muted'
                    }`}
                  >
                    <ContactAvatar contact={c.contact} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between">
                        <span className={`truncate text-xs ${attention ? 'font-bold' : 'font-semibold'} ${isSelected ? 'text-primary' : 'text-ink'}`}>
                          {contactName}
                        </span>
                        <span className="flex shrink-0 items-center">
                          {c.pinned && (
                            <svg aria-label="Pinned" className="mr-1 inline h-3 w-3 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9a2 2 0 0 1-1.1-1.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
                            </svg>
                          )}
                          <span className={`text-[10px] ${attention ? 'font-semibold text-accent' : 'text-faint'}`}>
                            {listTimestamp(c.lastMessageAt)}
                          </span>
                        </span>
                      </div>
                      {typingNames(typing, c.id).length > 0 ? (
                        <p className="mt-0.5 truncate text-[11px] font-medium text-accent">typing…</p>
                      ) : (
                        <p className={`mt-0.5 truncate text-[11px] ${attention ? 'font-semibold text-ink' : 'text-muted'}`}>
                          {c.lastMessage?.deletedAt ? <DeletedText /> : c.lastMessage ? (filePreview(c.lastMessage) ?? (c.lastMessage.body || 'No messages yet')) : 'No messages yet'}
                        </p>
                      )}
                      {(c.labels.length > 0 || c.assignee || c.contact.leadStage) && (
                        <div className="mt-1 flex min-w-0 items-center gap-1.5">
                          <StagePill value={c.contact.leadStage} />
                          {c.assignee && (
                            <span
                              title={`Assigned to ${c.assignee.name}`}
                              className="inline-flex max-w-24 shrink-0 items-center gap-1 text-[10px] font-medium text-body-soft"
                            >
                              <AssigneeAvatar assignee={c.assignee} size="h-3.5 w-3.5 text-[8px]" />
                              <span className="truncate">{c.assignee.name}</span>
                              <PresenceDot status={presenceOf(presence, c.assignee.userId)} size="h-1.5 w-1.5" />
                            </span>
                          )}
                          <LabelChips labels={c.labels} max={2} />
                        </div>
                      )}
                    </div>
                    {/* Fixed slot, so the row doesn't shift when the badge appears or goes away */}
                    <span className="flex w-5 shrink-0 justify-end">
                      {c.unread > 0 ? (
                        <span className="flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-on-primary">
                          {c.unread > 99 ? '99+' : c.unread}
                        </span>
                      ) : (
                        attention && <span title="Assigned to you, not opened yet" className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent" />
                      )}
                    </span>
                  </button>
                  
                </li>
              );
            })}
          </ul>
        )}
        {onLoadMore && (
          <button
            onClick={onLoadMore}
            disabled={loading}
            className="w-full border-t border-line-soft py-2.5 text-xs font-medium text-primary hover:bg-surface-muted disabled:opacity-50 transition"
          >
            Load more conversations
          </button>
        )}
      </div>
    </section>
  );
}

// Right Area Empty State with WhatsApp Wallpaper Pattern
function EmptyChatState() {
  return (
    <section className="relative z-10 flex h-full min-w-0 flex-1 overflow-hidden bg-chat-bg">
      {/* WhatsApp Doodle Ambient Texture */}
      <div
        className="pointer-events-none absolute inset-0 bg-chat-doodle opacity-[0.06]"
      />
    </section>
  );
}

function ChatPanel({
  conversation,
  messages,
  isChatLoading = false,
  onLoadOlder,
  onSent,
  meName,
  onOpenLabels,
  viewer,
  onMessageUpdated,
  onStatusChanged,
  onPinnedChanged,
  onMarkedUnread,
  onClosed,
  onCleared,
  onClaim,
  claimError,
  reopenError,
  typingNames: typers,
  onTyping,
  activity,
  meId,
  profileOpen,
  onToggleProfile,
  onOpenProfile,
  channelPhone,
  assignees,
}: {
  conversation: Conversation;
  meName: string; // you: the "My name" quick fill when sending a template
  messages: Message[];
  isChatLoading?: boolean;
  onLoadOlder?: () => void;
  onSent: (m: Message) => void;
  onOpenLabels: (anchor: HTMLElement) => void;
  viewer: { userId: string; isAdmin: boolean; role?: string } | null;
  onMessageUpdated: (m: Message) => void;
  onStatusChanged: (change: StatusChange) => void;
  // Called once this agent's "Close chat" succeeded: leave the chat and go back to the inbox list
  onClosed: () => void;
  onPinnedChanged: (id: string, pinned: boolean) => void;
  onMarkedUnread: (id: string, unread: number) => void;
  // "Clear chat" succeeded (for this user only)
  onCleared: () => void;
  // "Assign to Me" for an unassigned chat (New Lead), and why it failed if it did
  onClaim: () => void;
  claimError: string | null;
  // Opening a closed chat reopens it; this is set if that failed
  reopenError: string | null;
  // Other agents typing in this chat right now
  typingNames: string[];
  onTyping: (typing: boolean) => void;
  // This chat's history (closed, assigned, labelled, edited…), shown between the messages
  activity: Activity[];
  meId: string | null;
  // Contact profile side panel (the (i) button)
  profileOpen: boolean;
  onToggleProfile: () => void;
  // The customer's name (or picture) in the header: opens that panel
  onOpenProfile: () => void;
  // The workspace's WhatsApp number replies go out from ("via WhatsApp +971…" above the message box)
  channelPhone: string | null;
  // Teammates (for @mentions in notes: their colour)
  assignees: Assignee[];
}) {
  const presence = usePresence(); // online / away / offline dots next to assignees
  const [text, setText] = useState('');
  // Emoji picker and image sending
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null); // the image or document about to be sent
  const [attachOpen, setAttachOpen] = useState(false); // 📎 menu: Photo or document / Location
  const [locationOpen, setLocationOpen] = useState(false);
  const attachRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!attachOpen) return;
    const onDown = (e: MouseEvent) => attachRef.current && !attachRef.current.contains(e.target as Node) && setAttachOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setAttachOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [attachOpen]);
  // Your live locations in this chat (the bar above the message box, with Stop sharing)
  const myLives = useMyActiveLives(viewer?.userId).filter((l) => l.conversationId === conversation.id);
  const [template, setTemplate] = useState<Template | null>(null); // the template about to be sent (values to fill in)
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  // Voice note: the recorder replaces the message box while recording / previewing
  const [voiceMode, setVoiceMode] = useState(false);
  useEffect(() => setVoiceMode(false), [conversation.id]);
  // Above the message box: Reply (to the customer, on WhatsApp) or Add note (internal, only the team sees it; saved
  // to the customer's Remarks in the profile panel). Each chat opens on Reply.
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  // Internal notes in the chat (yellow bubbles): this customer's remarks, live (contact:remarks: added, edited or
  // deleted by anyone). Only shown to the team; never sent to WhatsApp.
  const [notes, setNotes] = useState<ContactRemark[]>([]);
  const notesFor = useRef(conversation.id);
  const loadNotes = useCallback(() => {
    const id = conversation.id;
    fetchChatNotes(id)
      .then((list) => notesFor.current === id && setNotes(list))
      .catch(() => {}); // the chat still works without them
  }, [conversation.id]);
  useEffect(() => {
    notesFor.current = conversation.id;
    setNotes([]);
    loadNotes();
  }, [conversation.id, loadNotes]);
  useEffect(() => {
    const on = (e: Event) => (e as CustomEvent<{ contactId?: string }>).detail?.contactId === conversation.contact.id && loadNotes();
    window.addEventListener(CONTACT_REMARKS_EVENT, on);
    return () => window.removeEventListener(CONTACT_REMARKS_EVENT, on);
  }, [conversation.contact.id, loadNotes]);
  useEffect(() => setMode('reply'), [conversation.id]);
  const [error, setError] = useState('');
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Message actions: open menu, message being edited in the composer, message awaiting delete confirmation
  const [menu, setMenu] = useState<{ message: Message; anchor: HTMLElement } | null>(null);
  // "Search in conversation": over the loaded messages; ↑ older, ↓ newer, Enter = ↑, Esc closes
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [matchPos, setMatchPos] = useState(0); // 0 = the newest match
  const searchInputRef = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => findMessageMatches(messages, searchOpen ? searchText : '').reverse(), [messages, searchOpen, searchText]); // newest first
  const currentMatchId = matches[Math.min(matchPos, Math.max(matches.length - 1, 0))];
  useEffect(() => setMatchPos(0), [searchText]);
  useEffect(() => {
    setSearchOpen(false);
    setSearchText('');
  }, [conversation.id]);
  useEffect(() => {
    if (!searchOpen || !currentMatchId) return;
    const el = messagesContainerRef.current?.querySelector(`[data-message-id="${currentMatchId}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [searchOpen, currentMatchId]);
  const stepMatch = (dir: 1 | -1) => {
    if (!matches.length) return;
    setMatchPos((p) => (p + dir + matches.length) % matches.length);
  };
  const [editing, setEditing] = useState<Message | null>(null);
  const noting = mode === 'note' && !editing; // editing a message is always a reply
  // WhatsApp's 24-hour window: over 24 hours since the customer last wrote (or they never did), only approved
  // templates can be sent, so the message box gives way to "Send template". A customer message arriving live opens
  // it again at once; a timer closes it at the exact moment it runs out. The server refuses the rest (WINDOW_CLOSED).
  const lastCustomerAt = lastCustomerMessageAt(conversation.lastInboundAt);
  const [, setWindowTick] = useState(0);
  useEffect(() => {
    const ms = msUntilClose(lastCustomerAt);
    if (ms === null) return;
    const t = setTimeout(() => setWindowTick((n) => n + 1), Math.min(ms + 250, 2_147_483_647));
    return () => clearTimeout(t);
  }, [lastCustomerAt]);
  // The server refused a send for the closed window (its clock decides): the box switches to "Send template" at once,
  // until the customer writes again (a new lastInboundAt)
  const [refusedAt, setRefusedAt] = useState<number | null | undefined>(undefined);
  useEffect(() => setRefusedAt(undefined), [conversation.id]); // per chat
  const windowClosed = !windowOpen(lastCustomerAt) || refusedAt === lastCustomerAt;
  const noteRefusal = (err: unknown) => isWindowClosedError(err, errorCode(err)) && setRefusedAt(lastCustomerAt);
  // Replying to this message (WhatsApp style): quoted above the message box and above the sent reply
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  // Forwarding this message to other chats (the Forward dialog)
  const [forwarding, setForwarding] = useState<Message | null>(null);
  // A reply's quote was clicked: the original is scrolled to and briefly marked
  const [flashId, setFlashId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Message | null>(null);
  // Just deleted by this agent: offered for undo for a few seconds
  const [undo, setUndo] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setText('');
    setError('');
    setMenu(null);
    setEditing(null);
    setReplyTo(null);
    setConfirmDelete(null);
    setUndo(null);
    setTemplate(null);
    // Opening a chat puts the cursor in the message box so you can start typing at once (as WhatsApp Web does);
    // not on touch-only devices, where it would pop up the keyboard over the chat
    if (window.matchMedia('(pointer: fine)').matches) requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  }, [conversation.id]);

  // Esc leaves the chat (back to the list), WhatsApp style - see escapeClosesChat for when it doesn't. What was
  // open and focused is noted first (capture), before menus and dialogs close themselves on the same Esc; the
  // decision comes last (bubble), after every other handler had its turn.
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  useEffect(() => {
    let start: { target: EscapeTarget | null; overlayOpen: boolean } | null = null;
    const onCapture = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      start = {
        target: el && { tagName: el.tagName, isContentEditable: el.isContentEditable, composerEmpty: el === inputRef.current ? inputRef.current.value === '' : null },
        overlayOpen: !!document.querySelector(OVERLAY_SELECTOR),
      };
    };
    const onBubble = (e: KeyboardEvent) => {
      const s = start;
      start = null;
      if (!s || !escapeClosesChat(e, s.target, s.overlayOpen)) return;
      e.preventDefault();
      inputRef.current?.blur();
      onClosedRef.current();
    };
    window.addEventListener('keydown', onCapture, true);
    window.addEventListener('keydown', onBubble);
    return () => {
      window.removeEventListener('keydown', onCapture, true);
      window.removeEventListener('keydown', onBubble);
    };
  }, []);

  const typingSender = useTypingSender(onTyping);
  // "/" at the start of the message box opens the quick replies menu; Esc hides it until you type again
  const [quickClosed, setQuickClosed] = useState(false);
  const [quickActive, setQuickActive] = useState(0);
  const quickSearch = !editing && !quickClosed ? slashQuery(text) : null;
  // "Add note": @ opens the list of teammates (name and email); picking one puts "@Name " at the cursor
  const [members, setMembers] = useState<WorkspaceMember[] | null>(null);
  useEffect(() => {
    if (mode === 'note' && members === null) fetchWorkspaceMembers().then(setMembers, () => setMembers([]));
  }, [mode, members]);
  const [caret, setCaret] = useState(0);
  // WhatsApp formatting: shown as you type (*bold*…); the small format bar appears while text in the box is selected
  const highlightRef = useRef<HTMLDivElement>(null);
  const [selecting, setSelecting] = useState(false);
  const [mentionClosed, setMentionClosed] = useState(false); // Esc: hidden until the text changes
  const mention = noting && !mentionClosed ? mentionAt(text, caret) : null;
  const mentionItems = useMemo(
    () =>
      mention
        ? matchMembers((members ?? []).filter((m) => m.id !== viewer?.userId), mention.query).map((m) => ({
            ...m,
            color: assignees.find((a) => a.userId === m.id)?.color ?? 'var(--color-primary)',
          }))
        : [],
    [mention?.query, mention !== null, members, viewer?.userId, assignees], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [mentionActive, setMentionActive] = useState(0);
  // Teammates picked from the list for this note; sent with it if their "@Name" is still in the text
  const [picked, setPicked] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => setPicked([]), [conversation.id]);
  // Add note → 📎: images and documents for the note (uploaded when it's saved, then attached to it)
  const [noteFiles, setNoteFiles] = useState<File[]>([]);
  const noteFileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setNoteFiles([]), [conversation.id]);
  function addNoteFiles(list: FileList | null) {
    const chosen = Array.from(list ?? []);
    const problems = chosen.map((f) => ('problem' in checkFile(f) ? `${f.name}: ${(checkFile(f) as { problem: string }).problem}` : null)).filter(Boolean);
    const ok = chosen.filter((f) => !('problem' in checkFile(f)));
    const room = NOTE_FILES_MAX - noteFiles.length;
    setNoteFiles((prev) => [...prev, ...ok.slice(0, Math.max(0, room))]);
    setError([...problems, ...(ok.length > room ? [`Up to ${NOTE_FILES_MAX} files per note`] : [])].join(' · '));
    requestAnimationFrame(() => inputRef.current?.focus());
  }
  useEffect(() => setMentionActive(0), [mention?.query]);
  function pickMention(m: MentionMember) {
    if (!mention) return;
    const r = insertMention(text, mention, m.name);
    setPicked((p) => (p.some((x) => x.id === m.id) ? p : [...p, { id: m.id, name: m.name }]));
    setText(r.text);
    setCaret(r.caret);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(r.caret, r.caret);
    });
  }
  const quick = useQuickReplies(quickSearch);
  useEffect(() => setQuickActive(0), [quickSearch]);
  // The message box grows with multi-line text (up to ~8 lines, then scrolls)
  useEffect(() => {
    if (inputRef.current) fitHeight(inputRef.current, 160);
    // The formatted text under the box scrolls with it
    if (inputRef.current && highlightRef.current) highlightRef.current.scrollTop = inputRef.current.scrollTop;
  }, [text]);
  function insertQuickReply(reply: QuickReply) {
    const next = reply.description ?? '';
    setText(next);
    typingSender.onInput(next);
    inputRef.current?.focus();
  }
  const closeMenu = useCallback(() => setMenu(null), []);
  const clearUndo = useCallback(() => setUndo(null), []);

  // Undo only applies to the copy that was deleted; drop it if someone changed the message meanwhile
  const undoLive = undo && messages.find((m) => m.id === undo.id);
  useEffect(() => {
    if (undo && undoLive && undoLive.version !== undo.version) setUndo(null);
  }, [undo, undoLive]);

  const isClosed = conversation.status === 'closed';
  const [statusBusy, setStatusBusy] = useState(false);

  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  async function doClear() {
    setClearing(true);
    setError('');
    try {
      await clearConversation(conversation.id);
      cancelEdit();
      setUndo(null);
      onCleared();
      loadNotes(); // notes before the clear are hidden for you too, like the messages
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  }

  async function togglePin() {
    setError('');
    try {
      const r = await setConversationPinned(conversation.id, !conversation.pinned);
      onPinnedChanged(r.id, r.pinned);
      const t = pinText(r.pinned, conversation.contact.name || `+${conversation.contact.waId}`); // only you: pins are personal
      showToast(t.key, r.id, t.message, t.detail);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // Back to unread, then leave the chat (staying in it would mark it read again)
  async function markUnread() {
    setError('');
    try {
      const r = await markConversationUnread(conversation.id);
      onMarkedUnread(r.id, r.unread);
      onClosed();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // A formatting change (toolbar or Ctrl/⌘+B, I, Shift+X, Shift+M), made as typing so Ctrl/⌘+Z undoes it: only the
  // part that changed is replaced, then the new selection is set. Falls back to setting the text directly.
  function applyFormat(next: Edit) {
    const el = inputRef.current;
    if (!el) return;
    const old = el.value;
    let a = 0;
    while (a < old.length && a < next.text.length && old[a] === next.text[a]) a++;
    let b = 0;
    while (b < old.length - a && b < next.text.length - a && old[old.length - 1 - b] === next.text[next.text.length - 1 - b]) b++;
    const insert = next.text.slice(a, next.text.length - b);
    el.focus();
    el.setSelectionRange(a, old.length - b);
    let done = false;
    try {
      done = insert ? document.execCommand('insertText', false, insert) : a < old.length - b ? document.execCommand('delete') : true;
    } catch {
      done = false;
    }
    if (!done || el.value !== next.text) setText(next.text);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.start, next.end);
      setCaret(next.start);
      setSelecting(next.start !== next.end);
    });
  }
  const formatInline = (style: InlineStyle) => {
    const el = inputRef.current;
    if (el) applyFormat(toggleInline(el.value, el.selectionStart, el.selectionEnd, style));
  };
  const formatLines = (style: LineStyle) => {
    const el = inputRef.current;
    if (el) applyFormat(toggleLines(el.value, el.selectionStart, el.selectionEnd, style));
  };

  // Emoji goes in at the cursor (or replaces the selection); the picker stays open for more
  function insertEmoji(emoji: string) {
    const el = inputRef.current;
    const next = insertAt(text, emoji, el?.selectionStart ?? text.length, el?.selectionEnd ?? text.length);
    setText(next.text);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.cursor, next.cursor);
    });
  }

  async function sendImageWithCaption(caption: string) {
    if (!imageFile) return;
    const m = await sendFile(conversation.id, imageFile, caption, replyTo?.id).catch((err) => {
      noteRefusal(err);
      throw err;
    });
    onSent(m);
    setImageFile(null);
    setReplyTo(null);
  }

  async function sendVoiceNote(recording: Blob) {
    const m = await sendVoice(conversation.id, recording, replyTo?.id).catch((err) => {
      noteRefusal(err);
      throw err;
    });
    onSent(m);
    setVoiceMode(false);
    setReplyTo(null);
  }

  // A chosen or dropped file: checked first (type, size), then the preview window
  function pickFile(f: File | undefined, many = false) {
    if (!f) return;
    if (windowClosed) return setError('24-hour window closed: only approved templates can be sent until the customer writes again.');
    const r = checkFile(f);
    if ('problem' in r) return setError(r.problem);
    setError(many ? 'One file at a time: sending the first one.' : '');
    setImageFile(f);
  }
  // Files can be sent (and dropped) only where the message box is: an open chat you may reply in
  const canAttach = !isClosed && !windowClosed && !editing && !(!conversation.assignee && viewer?.role !== 'supervisor' && !viewer?.isAdmin);
  // Reacting follows the reply rules (open chat you may write in); the message must have gone through WhatsApp
  const canReact = !isClosed && !windowClosed && !(!conversation.assignee && viewer?.role !== 'supervisor' && !viewer?.isAdmin);
  async function react(m: Message, emoji: string | null) {
    setError('');
    const before = m;
    onMessageUpdated({ ...m, teamReaction: emoji, teamReactionById: emoji ? (viewer?.userId ?? null) : null }); // shows at once
    try {
      onMessageUpdated(await reactToMessage(m.id, emoji));
    } catch (err) {
      onMessageUpdated(before);
      setError((err as Error).message);
    }
  }

  async function changeStatus(status: ConversationStatus, until?: Date) {
    setStatusBusy(true);
    setError('');
    try {
      const c = status === 'snoozed' && until ? await snoozeConversation(conversation.id, until) : await setConversationStatus(conversation.id, status === 'closed' ? 'closed' : 'open');
      onStatusChanged({ conversationId: c.id, status: c.status, closedAt: c.closedAt, closedById: c.closedById, snoozedUntil: c.snoozedUntil });
      // Only after the server confirmed: exit the chat (on failure we stay here and show the error)
      if (status === 'closed' || status === 'snoozed') onClosed();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStatusBusy(false);
    }
  }

  async function doUndo() {
    if (!undo || busy) return;
    setBusy(true);
    setError('');
    try {
      onMessageUpdated(await restoreMessage(undo.id, undo.version));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setUndo(null);
    }
  }

  // The message being replied to was deleted meanwhile: stop replying to it
  const replyLive = replyTo && messages.find((m) => m.id === replyTo.id);
  useEffect(() => {
    if (replyTo && replyLive?.deletedAt) {
      setReplyTo(null);
      setError('The message you were replying to was deleted.');
    }
  }, [replyTo, replyLive?.deletedAt]);

  // Go to the message a reply quotes (if it's loaded) and mark it for a moment
  function jumpTo(id: string) {
    const el = messagesContainerRef.current?.querySelector(`[data-message-id="${id}"]`);
    if (!el) return setError('The original message is further up: load earlier messages to see it.');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlashId(id);
    setTimeout(() => setFlashId((f) => (f === id ? null : f)), 1600);
  }

  // Someone else deleted the message being edited: stop editing it
  const editingLive = editing && messages.find((m) => m.id === editing.id);
  useEffect(() => {
    if (editing && editingLive?.deletedAt) {
      setEditing(null);
      setText('');
      setError('That message was deleted, so the edit was discarded.');
    }
  }, [editing, editingLive?.deletedAt]);

  function onAction(snapshot: Message, action: MessageAction) {
    const m = messages.find((x) => x.id === snapshot.id) ?? snapshot; // latest copy
    setMenu(null);
    setError('');
    if (action === 'forward') {
      setForwarding(m);
    } else if (action === 'reply') {
      setMode('reply');
      if (editing) cancelEdit();
      setReplyTo(m);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (action === 'copy') {
      navigator.clipboard?.writeText(m.body).catch(() => setError("Couldn't copy to the clipboard"));
    } else if (action === 'edit') {
      setMode('reply');
      setReplyTo(null);
      setEditing(m);
      setText(m.body);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setConfirmDelete(m);
    }
  }

  function cancelEdit() {
    setEditing(null);
    setText('');
  }

  // Add note: an internal note on the customer (their Remarks in the profile panel; everyone sees it there live)
  async function saveNote(body: string) {
    if (busy || (!body.trim() && !noteFiles.length)) return;
    setBusy(true);
    setError('');
    try {
      const mentions = picked.filter((m) => body.includes(`@${m.name}`)).map((m) => m.id);
      // Files first (one by one), then the note with them; if anything fails, the text and files stay to try again
      const fileIds: string[] = [];
      for (const f of noteFiles) fileIds.push((await uploadRemarkFile(conversation.contact.id, f)).id);
      await addRemark(conversation.contact.id, body.trim(), mentions, fileIds);
      setText('');
      setPicked([]);
      setNoteFiles([]);
      showToast(`note:${conversation.id}:${Date.now()}`, conversation.id, 'Note added', "Saved to the customer's Remarks · only your team sees it");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!editing || busy) return;
    const body = text.trim();
    if (!body) return setError('Message cannot be empty');
    if (body === editing.body) return cancelEdit();
    setBusy(true);
    setError('');
    try {
      // Send the version editing started from, so a change made meanwhile by someone else is reported, not overwritten
      onMessageUpdated(await editMessage(editing.id, body, editing.version));
      cancelEdit();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    if (!confirmDelete) return;
    const live = messages.find((m) => m.id === confirmDelete.id) ?? confirmDelete;
    setBusy(true);
    setError('');
    try {
      const deleted = await deleteMessage(live.id, live.version);
      onMessageUpdated(deleted);
      if (editing?.id === live.id) cancelEdit();
      setConfirmDelete(null);
      setUndo(deleted);
    } catch (err) {
      setError((err as Error).message);
      setConfirmDelete(null);
    } finally {
      setBusy(false);
    }
  }

  // Messages, activity and internal notes in time order. While older messages aren't loaded yet, skip activity and
  // notes older than the first loaded message so they don't pile up at the top.
  const oldestLoaded = onLoadOlder && messages[0] ? messages[0].createdAt : null;
  const stream = [
    ...messages.map((m) => ({ kind: 'message' as const, at: m.createdAt, id: m.id, m })),
    ...activity
      .filter((a) => !oldestLoaded || a.createdAt >= oldestLoaded)
      .map((a) => ({ kind: 'activity' as const, at: a.createdAt, id: a.id, a })),
    ...notes
      .filter((n) => !oldestLoaded || n.createdAt >= oldestLoaded)
      .map((n) => ({ kind: 'note' as const, at: n.createdAt, id: `note:${n.id}`, n })),
  ].sort((x, y) => x.at.localeCompare(y.at));
  const teammateNames = useMemo(() => assignees.map((a) => a.name), [assignees]);

  // Scroll only when something newer arrives or conversation changes, restoring saved scroll on refresh
  const lastId = stream.at(-1)?.id;
  const chatScrollKey = `support:scroll:chat:${conversation.id}`;
  const prevScrollHeightRef = useRef<number | null>(null);
  const prevConvIdRef = useRef<string>(conversation.id);
  const prevLastIdRef = useRef<string | undefined>(lastId);
  // Whether the reader is at the newest message, measured as they scroll (before anything new is drawn, so a tall
  // new message or image can't make it look as if they had scrolled up)
  const atBottomRef = useRef(true);
  const [unseen, setUnseen] = useState(0); // new messages that arrived while scrolled up
  const nearBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  const toBottom = (el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setUnseen(0);
  };

  const onChatScroll = (e: React.UIEvent<HTMLDivElement>) => {
    atBottomRef.current = nearBottom(e.currentTarget);
    if (atBottomRef.current) setUnseen(0);
    try {
      sessionStorage.setItem(chatScrollKey, String(e.currentTarget.scrollTop));
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;

    // 1. Switched to a different conversation
    if (prevConvIdRef.current !== conversation.id) {
      prevConvIdRef.current = conversation.id;
      prevLastIdRef.current = lastId;
      setUnseen(0);
      try {
        const saved = sessionStorage.getItem(chatScrollKey);
        if (saved !== null) {
          el.scrollTop = Number(saved);
          atBottomRef.current = nearBottom(el);
          return;
        }
      } catch {}
      toBottom(el);
      return;
    }

    // 2. Older messages were loaded (anchoring scroll)
    if (prevScrollHeightRef.current !== null) {
      const diff = el.scrollHeight - prevScrollHeightRef.current;
      el.scrollTop += diff;
      prevScrollHeightRef.current = null;
      return;
    }

    // 3. Something new at the bottom: follow it if the reader was at the bottom, or if it's their own message;
    //    otherwise leave them where they are reading and count it on the "new messages" button
    if (prevLastIdRef.current !== lastId) {
      prevLastIdRef.current = lastId;
      const newest = stream.at(-1);
      const mine = newest?.kind === 'message' && newest.m.direction === 'out' && !!meId && newest.m.sentById === meId;
      if (atBottomRef.current || mine) {
        toBottom(el);
        try {
          sessionStorage.setItem(chatScrollKey, String(el.scrollTop));
        } catch {}
      } else if (newest?.kind === 'message') setUnseen((n) => n + 1);
      return;
    }

    // 4. Initial mount / refresh: restore scroll if saved
    try {
      const saved = sessionStorage.getItem(chatScrollKey);
      if (saved !== null) {
        el.scrollTop = Number(saved);
        atBottomRef.current = nearBottom(el);
        return;
      }
    } catch {}
    toBottom(el);
  }, [conversation.id, lastId, chatScrollKey]);

  // Images, videos and voice notes get their height when they finish loading: stay at the bottom if the reader is there
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const keep = () => {
      if (atBottomRef.current) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener('load', keep, true); // load doesn't bubble: listen while it travels down
    el.addEventListener('loadedmetadata', keep, true);
    return () => {
      el.removeEventListener('load', keep, true);
      el.removeEventListener('loadedmetadata', keep, true);
    };
  }, []);

  const handleLoadOlder = () => {
    const el = messagesContainerRef.current;
    if (el) prevScrollHeightRef.current = el.scrollHeight;
    onLoadOlder?.();
  };

  async function send(body: string) {
    setError('');
    const quoted = replyTo;
    try {
      onSent(await sendTextMessage(conversation.id, body, quoted?.id));
      setReplyTo((r) => (r?.id === quoted?.id ? null : r)); // sent as a reply: the bar goes away
    } catch (err) {
      setError((err as Error).message);
      noteRefusal(err);
      setText((t) => t || body); // not sent: the text comes back (unless something new was typed meanwhile)
    }
  }

  // The customer this chat is with (never the logged-in agent)
  const contactName = contactDisplayName(conversation.contact);

  return (
    <section
      className="relative z-10 flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-chat-bg"
      // Drag a photo or document onto the chat to send it (same checks and preview as the paperclip)
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = canAttach ? 'copy' : 'none';
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (!canAttach) return setError(isClosed ? 'This chat is closed. Reopen it to send files.' : windowClosed ? '24-hour window closed: only approved templates can be sent until the customer writes again.' : 'Assign this chat to yourself before sending files (New Leads → Assign to Me).');
        const files = e.dataTransfer.files;
        pickFile(files[0], files.length > 1);
      }}
      // A pasted screenshot or copied file (⌘V / Ctrl+V in the message box or anywhere in the chat) opens the same
      // preview as a chosen file; pasted text is left to the box as usual
      onPaste={(e) => {
        const files = [...e.clipboardData.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f);
        if (!files.length) return;
        e.preventDefault();
        if (!canAttach) return setError(isClosed ? 'This chat is closed. Reopen it to send files.' : windowClosed ? '24-hour window closed: only approved templates can be sent until the customer writes again.' : 'Assign this chat to yourself before sending files (New Leads → Assign to Me).');
        pickFile(pastedName(files[0]), files.length > 1);
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-40 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-surface/85 text-center">
          <svg className="h-9 w-9 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
          </svg>
          <p className="mt-2 text-sm font-semibold text-ink">{canAttach ? 'Drop to send' : "Files can't be sent in this chat"}</p>
          <p className="mt-0.5 text-xs text-muted">{canAttach ? 'JPEG or PNG images up to 5 MB · PDF, Word, Excel, PowerPoint or text up to 100 MB' : isClosed ? 'Reopen the chat first.' : windowClosed ? '24-hour window closed: send a template instead.' : 'Assign it to yourself first.'}</p>
        </div>
      )}
      {/* Ambient Doodle Pattern */}
      <div
        className="pointer-events-none absolute inset-0 bg-chat-doodle opacity-[0.05]"
      />

      {/* Chat Top Header (above the message stream so its ⋮ menu opens on top of the messages) */}
      <header className="relative z-20 flex h-14 shrink-0 items-center justify-between border-b border-line/90 bg-surface px-5 shadow-2xs">
        <div className="flex min-w-0 items-center gap-3">
          {/* Lead stage: one click to change it (saved to the customer's profile) */}
          <StageMenu
            contactId={conversation.contact.id}
            value={conversation.contact.leadStage}
            conversationId={conversation.id}
            contactName={contactName}
            onSaved={(c) => window.dispatchEvent(new CustomEvent(CONTACT_UPDATED_EVENT, { detail: c }))}
          />
          <span className="h-6 w-px shrink-0 bg-line" aria-hidden="true" />
          {/* The customer's picture and name open their profile panel (the (i) button does too) */}
          <button type="button" onClick={onOpenProfile} tabIndex={-1} aria-hidden="true" className="shrink-0 cursor-pointer rounded-full">
            <ContactAvatar contact={conversation.contact} size="h-9 w-9 text-xs" />
          </button>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={onOpenProfile}
                title={`${contactName}: open contact profile`}
                aria-label={`${contactName}: open contact profile`}
                className="min-w-0 cursor-pointer truncate rounded text-left text-xs font-bold text-ink"
              >
                {contactName}
              </button>
              {/* {isClosed && (
                <span className="shrink-0 rounded-full border border-line bg-surface-strong px-2 py-px text-[10px] font-semibold text-muted">
                  Closed
                </span>
              )} */}
              <div className="hidden min-w-0 sm:block">
                <LabelChips labels={conversation.labels} max={3} />
              </div>
            </div>
            {typers.length > 0 ? (
              <p className="truncate text-[11px] font-medium text-primary" aria-live="polite">
                {typingLabel(typers)}
                <TypingDots />
              </p>
            ) : (
              <p className="truncate text-[11px] text-muted">
                {/* The number is already the title when the customer hasn't shared a name */}
                {conversation.contact.name ? `+${conversation.contact.waId}` : 'WhatsApp contact'}
                {conversation.assignee && (
                  <span>
                    {' · Assigned to '}
                    {conversation.assignee.name} <PresenceDot status={presenceOf(presence, conversation.assignee.userId)} size="h-1.5 w-1.5" withLabel />
                  </span>
                )}
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          <CollaboratorsButton
            conversationId={conversation.id}
            meId={viewer?.userId ?? null}
            contactName={conversation.contact.name || `+${conversation.contact.waId}`}
            canEdit={!!viewer} // every role adds and removes collaborators
          />
          <button
            type="button"
            title="Search in conversation"
            aria-label="Search in conversation"
            aria-pressed={searchOpen}
            onClick={() => {
              setSearchOpen((o) => !o);
              setTimeout(() => searchInputRef.current?.focus(), 0);
            }}
            className={`flex h-7 w-7 items-center justify-center rounded-full border transition ${searchOpen ? 'border-primary text-primary' : 'border-line text-body-soft hover:bg-surface-strong hover:text-body'}`}
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </button>
          <CountryCodeMenu contactId={conversation.contact.id} country={conversation.contact.country} waId={conversation.contact.waId} />
          <button
            onClick={(e) => onOpenLabels(e.currentTarget)}
            title="Label chat"
            className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] font-medium text-body-soft hover:bg-surface-strong hover:text-body transition"
          >
            <TagIcon className="h-3 w-3" />
            <span>{conversation.labels.length > 0 ? `Labels (${conversation.labels.length})` : 'Label'}</span>
          </button>
          <button
            type="button"
            title={profileOpen ? 'Hide contact profile' : 'Contact profile'}
            aria-label="Contact profile"
            aria-pressed={profileOpen}
            onClick={onToggleProfile}
            className={`flex h-7 w-7 items-center justify-center rounded-full border transition ${profileOpen ? 'border-primary text-primary' : 'border-line text-body-soft hover:bg-surface-strong hover:text-body'}`}
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4M12 8h.01" />
            </svg>
          </button>
          {!isClosed && (
            <ChatOptionsMenu
              disabled={statusBusy}
              busy={statusBusy}
              options={[
                { label: conversation.pinned ? 'Unpin conversation' : 'Pin conversation', icon: PinIcon, onSelect: () => togglePin() },
                { label: 'Mark as unread', icon: UnreadIcon, onSelect: () => markUnread() },
                { label: 'Clear chat', icon: ClearIcon, onSelect: () => setConfirmClear(true) },
                { label: 'Close chat', icon: CloseIcon, onSelect: () => changeStatus('closed') },
                ...(conversation.status === 'snoozed'
                  ? [{ label: 'Unsnooze', icon: SnoozeIcon, onSelect: () => changeStatus('open') }]
                  : [
                      {
                        label: 'Snooze',
                        icon: SnoozeIcon,
                        children: snoozeChoices().map((s) => ({ label: s.label, hint: snoozedUntilText(s.until.toISOString()), onSelect: () => changeStatus('snoozed', s.until) })),
                      },
                    ]),
              ]}
            />
          )}
          {/* {process.env.NODE_ENV !== 'production' && (
            <button
              onClick={async () => {
                const body = prompt('Enter simulated reply text:', '');
                if (!body) return;
                await simulateIncomingMessage({
                  waId: conversation.contact.waId,
                  name: conversation.contact.name || 'Customer',
                  body,
                });
              }}
              title=  "Dev only: Fake customer reply from this number without webhook"
              className="rounded-full border border-dashed border-primary/40 bg-primary-subtle px-2.5 py-1 text-[11px] font-medium text-primary hover:bg-primary-soft transition"
            >
              ⚡ Simulate Reply
            </button>
          )} */}
        </div>
      </header>

      {searchOpen && (
        <div className="relative z-10 flex shrink-0 items-center gap-2 border-b border-line/90 bg-surface px-4 py-1.5 text-xs">
          <svg className="h-3.5 w-3.5 shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={searchInputRef}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                stepMatch(e.shiftKey ? -1 : 1);
              } else if (e.key === 'Escape') {
                setSearchOpen(false);
                setSearchText('');
              }
            }}
            placeholder="Search in conversation..."
            aria-label="Search in conversation"
            className="min-w-0 flex-1 bg-transparent text-xs text-ink placeholder:text-faint outline-none"
          />
          <span className="shrink-0 tabular-nums text-[11px] text-muted" aria-live="polite">
            {searchText.trim() ? `${matches.length ? Math.min(matchPos, matches.length - 1) + 1 : 0} of ${matches.length}` : ''}
          </span>
          <button type="button" title="Older match" aria-label="Older match" disabled={matches.length < 2} onClick={() => stepMatch(1)} className="rounded-md p-1 text-body-soft hover:bg-surface-strong disabled:opacity-40">
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m18 15-6-6-6 6" />
            </svg>
          </button>
          <button type="button" title="Newer match" aria-label="Newer match" disabled={matches.length < 2} onClick={() => stepMatch(-1)} className="rounded-md p-1 text-body-soft hover:bg-surface-strong disabled:opacity-40">
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          <button
            type="button"
            title="Close search"
            aria-label="Close search"
            onClick={() => {
              setSearchOpen(false);
              setSearchText('');
            }}
            className="rounded-md p-1 text-body-soft hover:bg-surface-strong"
          >
            ✕
          </button>
        </div>
      )}

      {/* Messages Stream (the ref scrolls it to the newest message) */}
      <div
        ref={messagesContainerRef}
        onScroll={onChatScroll}
        style={{ scrollbarGutter: 'stable' }}
        className="relative z-10 flex-1 min-h-0 space-y-2.5 overflow-y-auto px-6 py-4"
      >
        {onLoadOlder && (
          <div className="flex justify-center">
            <button
              onClick={handleLoadOlder}
              className="rounded-full bg-surface/90 px-3 py-1 text-[11px] font-medium text-body-soft shadow-xs hover:bg-surface transition"
            >
              Load earlier messages
            </button>
          </div>
        )}
        {stream.map((item, i) => {
          // WhatsApp-style day separator (Today / Yesterday / date, in the app time zone) where the day changes
          const day = dayKey(item.at);
          const separator = (i === 0 || dayKey(stream[i - 1].at) !== day) && (
            <div className="flex justify-center py-1">
              <span className="rounded-lg bg-surface/90 px-3 py-1 text-[11px] font-medium text-body-soft shadow-2xs">
                {dayLabel(item.at)}
              </span>
            </div>
          );
          if (item.kind === 'note')
            return (
              <Fragment key={item.id}>
                {separator}
                <NoteBubble note={item.n} teammateNames={teammateNames} />
              </Fragment>
            );
          if (item.kind === 'activity')
            return (
              <Fragment key={item.id}>
                {separator}
                <div className="flex justify-center">
                  <span className="rounded-full bg-surface/90 px-3 py-1 text-center text-[11px] text-muted shadow-2xs">
                    {activityText(item.a, meId, 'chat')} · {formatTime(item.a.createdAt)}
                  </span>
                </div>
              </Fragment>
            );
          const m = item.m;
          const actions = messageActions(m, viewer, canReact);
          return (
            <Fragment key={m.id}>
              {separator}
              <MessageBubble
                message={m}
                actions={actions}
                highlighted={menu?.message.id === m.id || editing?.id === m.id || replyTo?.id === m.id || flashId === m.id}
                onOpenMenu={(anchor) => setMenu({ message: m, anchor })}
                onJumpTo={jumpTo}
                viewer={viewer}
                highlightTerm={searchOpen ? searchText : ''}
                currentMatch={searchOpen && m.id === currentMatchId}
                onReact={canReact && !m.deletedAt && m.status !== 'failed' && m.status !== 'pending' ? (emoji) => react(m, emoji) : undefined}
              />
            </Fragment>
          );
        })}
        {unseen > 0 && (
          <div className="pointer-events-none sticky bottom-1 z-20 flex justify-center">
            <button
              type="button"
              onClick={() => messagesContainerRef.current && toBottom(messagesContainerRef.current)}
              className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[12px] font-semibold text-on-primary shadow-lg hover:bg-primary-hover"
            >
              {unseen} new {unseen === 1 ? 'message' : 'messages'}
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14M5 12l7 7 7-7" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Bottom Message Composer */}
      <footer className="relative z-10 shrink-0 border-t border-line/90 bg-surface p-3">
        {error && (
          <div className="mb-2 rounded-lg bg-danger-soft px-3 py-1.5 text-xs text-danger">{error}</div>
        )}
        {!noting && !error && overLimit(text, WHATSAPP_TEXT_MAX) && (
          <div className="mb-2 rounded-lg bg-danger-soft px-3 py-1.5 text-xs text-danger" role="status">
            {tooLongText(text, WHATSAPP_TEXT_MAX)}
          </div>
        )}

        {undo && <UndoToast key={undo.id} busy={busy} onUndo={doUndo} onDone={clearUndo} />}

        {replyTo && !editing && !isClosed && !windowClosed && (
          <div className="mb-2 flex items-start gap-2 rounded-lg bg-surface-muted p-1.5" aria-label="Replying to">
            <QuoteBlock
              quote={{
                id: replyTo.id,
                direction: replyTo.direction,
                type: replyTo.type,
                body: replyTo.body,
                senderName: replyTo.senderName ?? (replyTo.automation ? 'Auto-reply' : null),
                deleted: false,
                mediaMime: replyTo.mediaMime,
                mediaName: replyTo.mediaName,
              }}
            />
            <button type="button" onClick={() => setReplyTo(null)} title="Cancel reply" aria-label="Cancel reply" className="px-1.5 py-1 text-faint hover:text-body-soft">
              ✕
            </button>
          </div>
        )}

        {editing && (
          <div className="mb-2 flex items-start gap-2 rounded-lg border-l-4 border-primary bg-primary-subtle px-3 py-1.5 text-xs">
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-primary">Edit message</p>
              <p className="truncate text-muted">{editing.body}</p>
            </div>
            <button type="button" onClick={cancelEdit} title="Cancel edit" className="text-faint hover:text-body-soft">
              ✕
            </button>
          </div>
        )}

        {mention && !isClosed && (
          <MentionMenu members={mentionItems} loading={members === null} active={mentionActive} onHover={setMentionActive} onPick={pickMention} />
        )}
        {quickSearch !== null && !isClosed && (
          <QuickReplyMenu
            query={quickSearch}
            items={quick.items}
            loading={quick.loading}
            error={quick.error}
            active={quickActive}
            onHover={setQuickActive}
            onPick={insertQuickReply}
          />
        )}

        {conversation.status === 'snoozed' && !editing && (
          <div className="mb-2 flex items-center justify-between gap-3 rounded-xl bg-warning-soft px-4 py-2 text-xs text-warning">
            <span>Snoozed until {snoozedUntilText(conversation.snoozedUntil)}. It comes back on its own, or when the customer writes.</span>
            <button type="button" disabled={statusBusy} onClick={() => changeStatus('open')} className="shrink-0 rounded-lg px-2 py-1 font-semibold hover:bg-warning-soft-hover disabled:opacity-50">
              Unsnooze
            </button>
          </div>
        )}
        {isClosed && !editing ? (
          <p className="rounded-xl bg-surface-muted px-4 py-2.5 text-center text-xs text-muted">
            {reopenError
              ? `Couldn't reopen this chat: ${reopenError}. Click it in the chat list to try again.`
              : 'This chat is closed. Click it in the chat list to reopen it.'}
          </p>
        ) : !conversation.assignee && !editing && !noting && viewer?.role !== 'supervisor' && !viewer?.isAdmin ? (
          // New Lead, as an agent: take it before replying (the server refuses agents' replies too). Owners, admins
          // and supervisors get the normal composer and may reply without taking the chat. An internal note doesn't
          // need the chat: "Add note" opens the note box (its Reply tab comes back here).
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-3 rounded-xl bg-primary-subtle px-4 py-2.5 text-xs">
              <span className="text-body">New lead: assign it to yourself to reply to the customer.</span>
              <button
                type="button"
                onClick={() => {
                  setMode('note');
                  requestAnimationFrame(() => inputRef.current?.focus());
                }}
                className="ml-auto shrink-0 rounded-lg border border-warning-border bg-warning-soft px-3 py-1.5 font-semibold text-warning hover:bg-warning-soft-hover"
              >
                Add note
              </button>
              <button
                type="button"
                onClick={onClaim}
                className="shrink-0 rounded-lg bg-primary px-3 py-1.5 font-semibold text-on-primary hover:bg-primary-hover"
              >
                Assign to Me
              </button>
            </div>
            {claimError && <p className="rounded-lg bg-danger-soft px-3 py-1.5 text-xs text-danger">{claimError}</p>}
          </div>
        ) : (
        voiceMode ? (
          <VoiceRecorder onSend={sendVoiceNote} onClose={() => setVoiceMode(false)} />
        ) : (
        <>
        {/* Your live location in this chat: until when, and Stop sharing */}
        {myLives.map((l) => (
          <div key={l.messageId} className="mb-2 flex items-center gap-2 rounded-lg border border-success/30 bg-success-soft px-3 py-1.5 text-xs text-ink" role="status">
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[#22c55e]" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">
              You&apos;re sharing your live location until {formatTime(l.until)}. Keep this app open so it keeps updating.
            </span>
            <button
              type="button"
              onClick={() => stopSharing(l.messageId).catch((err) => setError((err as Error).message))}
              className="shrink-0 rounded-md bg-danger px-2.5 py-1 font-semibold text-white hover:opacity-90"
            >
              Stop sharing
            </button>
          </div>
        ))}
        {/* Reply / Add note, Template, and the number replies go out from */}
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
          <div role="tablist" aria-label="Message type" className="flex items-center gap-0.5 rounded-lg bg-surface-muted p-0.5">
            {(
              [
                { key: 'reply', label: 'Reply', icon: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /> },
                { key: 'note', label: 'Add note', icon: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /> },
              ] as const
            ).map((t) => {
              const on = (t.key === 'note') === noting;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  disabled={!!editing && t.key === 'note'}
                  onClick={() => {
                    setMode(t.key);
                    if (t.key === 'note') {
                      setReplyTo(null);
                      setTemplate(null);
                    }
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                  className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 font-semibold transition disabled:opacity-40 ${
                    on ? (t.key === 'note' ? 'bg-warning-soft-hover text-warning shadow-xs' : 'bg-surface text-primary shadow-xs') : 'text-muted hover:text-body'
                  }`}
                >
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {t.icon}
                  </svg>
                  {t.label}
                </button>
              );
            })}
          </div>
          {!noting && !(windowClosed && !editing) && <TemplatePicker disabled={!!editing} highlight={false} onPick={setTemplate} />}
          
        </div>
        {noting && noteFiles.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Files for this note">
            {noteFiles.map((f, i) => (
              <li key={`${f.name}:${i}`} className="flex max-w-[240px] items-center gap-2 rounded-lg border border-warning-border bg-warning-soft px-2 py-1 text-[12px]">
                <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[9px] font-bold text-body-soft">{documentLabel(f.type, f.name)}</span>
                <span className="min-w-0 truncate text-ink" title={f.name}>
                  {f.name}
                </span>
                <span className="shrink-0 text-[10px] text-faint">{formatSize(f.size)}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setNoteFiles((prev) => prev.filter((_, j) => j !== i))}
                  aria-label={`Remove ${f.name}`}
                  className="shrink-0 rounded px-1 text-faint hover:text-ink disabled:opacity-40"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        {template && !noting && !editing ? (
          // A chosen template: filled in, previewed and sent right here (inside or outside the 24-hour window)
          <TemplateComposer
            key={`${conversation.id}:${template.name}:${template.language}`}
            template={template}
            conversationId={conversation.id}
            customer={{ id: conversation.contact.id, name: conversation.contact.name, waId: conversation.contact.waId }}
            meName={meName}
            onSent={onSent}
            onClose={() => {
              setTemplate(null);
              requestAnimationFrame(() => inputRef.current?.focus());
            }}
          />
        ) : windowClosed && !noting && !editing ? (
          // After 24 hours: no typing or sending, only an approved template (Add note still works: it stays internal)
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning-border bg-warning-soft px-4 py-3 text-xs" role="status">
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-warning">24-hour window closed</p>
              <p className="mt-0.5 text-body-soft">
                {lastCustomerAt
                  ? `The customer last wrote ${formatDateTime(lastCustomerAt)}. `
                  : "The customer hasn't written yet. "}
                WhatsApp only allows approved templates until they write again.
              </p>
            </div>
            <TemplatePicker variant="primary" disabled={false} highlight onPick={setTemplate} />
          </div>
        ) : (
        <>
        {selecting && <FormatToolbar onInline={formatInline} onLines={formatLines} />}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            typingSender.stop();
            // Over WhatsApp's limit for one message: kept as typed, nothing sent (the warning above says why)
            if (!noting && overLimit(text, WHATSAPP_TEXT_MAX)) return setError(tooLongText(text, WHATSAPP_TEXT_MAX));
            if (editing) return void saveEdit();
            if (noting) return void saveNote(text); // a note may be files only
            if (!text.trim()) return;
            send(text);
            setText('');
          }}
          className="flex items-center gap-2"
        >
          {/* Emoji: opens the picker above the message box; picks go in at the cursor */}
          <div className="relative">
          {emojiOpen && <EmojiPicker onPick={insertEmoji} onClose={() => setEmojiOpen(false)} />}
          <button
            type="button"
            data-emoji-toggle
            aria-expanded={emojiOpen}
            onClick={() => setEmojiOpen((o) => !o)}
            className={`flex h-9 w-9 items-center justify-center rounded-xl transition hover:bg-surface-strong ${emojiOpen ? 'text-primary' : 'text-faint hover:text-body-soft'}`}
            title="Add emoji"
            aria-label="Add emoji"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M8 14s1.5 2 4 2 4-2 4-2" />
              <line x1="9" y1="9" x2="9.01" y2="9" />
              <line x1="15" y1="9" x2="15.01" y2="9" />
            </svg>
          </button>
          </div>

          {/* Attach an image (JPEG/PNG up to 5 MB): preview + caption, then send */}
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            aria-label="Choose a file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = ''; // the same file can be chosen again
              pickFile(f);
            }}
          />
          {noting && (
            <>
              <input
                ref={noteFileInputRef}
                type="file"
                multiple
                accept={ACCEPT}
                className="hidden"
                aria-hidden="true"
                onChange={(e) => {
                  addNoteFiles(e.target.files);
                  e.target.value = ''; // the same file can be chosen again
                }}
              />
              <button
                type="button"
                onClick={() => noteFileInputRef.current?.click()}
                disabled={busy || noteFiles.length >= NOTE_FILES_MAX}
                className="flex h-9 w-9 items-center justify-center rounded-xl text-faint transition hover:bg-surface-strong hover:text-body-soft disabled:opacity-40"
                title="Attach images or documents to the note (only your team sees them)"
                aria-label="Attach files to the note"
              >
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
            </>
          )}
          {!noting && (
          <div className="relative" ref={attachRef}>
          {/* 📎: a photo or document (or drag a file onto the chat), or a location */}
          <button
            type="button"
            onClick={() => setAttachOpen((o) => !o)}
            disabled={!!editing}
            aria-haspopup="menu"
            aria-expanded={attachOpen}
            className={`flex h-9 w-9 items-center justify-center rounded-xl transition hover:bg-surface-strong disabled:opacity-40 ${attachOpen ? 'text-primary' : 'text-faint hover:text-body-soft'}`}
            title="Attach: photo, document or location"
            aria-label="Attach"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          {attachOpen && (
            <div role="menu" aria-label="Attach" className="absolute bottom-11 left-0 z-30 w-52 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-lg">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAttachOpen(false);
                  fileInputRef.current?.click();
                }}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] text-ink hover:bg-surface-muted"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#7c4dff] text-white" aria-hidden="true">
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" /></svg>
                </span>
                Photo or document
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAttachOpen(false);
                  setError('');
                  setLocationOpen(true);
                }}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] text-ink hover:bg-surface-muted"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#22a06b] text-white" aria-hidden="true">
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z" /></svg>
                </span>
                Location
              </button>
            </div>
          )}
          </div>
          )}

          {/* Main Message Input: Enter sends, Shift+Enter adds a line (quick replies keep their line breaks).
              Its text is drawn by ComposerHighlight underneath, formatted as you type (*bold*, _italic_…), like
              WhatsApp; the box itself keeps the cursor, selection and placeholder. */}
          <div
            className={`relative min-w-0 flex-1 rounded-xl transition ${
              noting ? 'bg-warning-soft' : 'bg-surface-muted/70 focus-within:bg-surface'
            }`}
          >
          {/* Same box, font and spacing as the text box; no kerning in either, so slanted words keep their places */}
          <ComposerHighlight ref={highlightRef} text={text} className="border border-transparent px-4 py-2.5 text-xs leading-relaxed text-ink [font-kerning:none] [font-variant-ligatures:none]" />
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            onScroll={(e) => {
              if (highlightRef.current) highlightRef.current.scrollTop = e.currentTarget.scrollTop;
            }}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
              setQuickClosed(false); // Esc hides the menu only until the text changes
              setMentionClosed(false);
              typingSender.onInput(e.target.value);
            }}
            onSelect={(e) => {
              setCaret(e.currentTarget.selectionStart);
              setSelecting(e.currentTarget.selectionStart !== e.currentTarget.selectionEnd);
            }}
            onBlur={() => {
              typingSender.stop();
              setSelecting(false);
            }}
            onKeyDown={(e) => {
              // WhatsApp Desktop shortcuts: Ctrl/⌘+B bold, +I italic, +Shift+X strikethrough, +Shift+M monospace
              const style = shortcutStyle(e);
              if (style) {
                e.preventDefault();
                return formatInline(style);
              }
              if (mention) {
                const count = mentionItems.length;
                if (e.key === 'ArrowDown' && count) {
                  e.preventDefault();
                  return setMentionActive((i) => (i + 1) % count);
                }
                if (e.key === 'ArrowUp' && count) {
                  e.preventDefault();
                  return setMentionActive((i) => (i - 1 + count) % count);
                }
                if (((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') && count && !e.nativeEvent.isComposing) {
                  e.preventDefault(); // insert the teammate, don't save the note
                  return pickMention(mentionItems[Math.min(mentionActive, count - 1)]);
                }
                if (e.key === 'Escape') {
                  e.preventDefault(); // closes the list only (not the chat)
                  return setMentionClosed(true);
                }
              }
              if (quickSearch !== null) {
                const count = quick.items.length;
                if (e.key === 'ArrowDown' && count) {
                  e.preventDefault();
                  return setQuickActive((i) => (i + 1) % count);
                }
                if (e.key === 'ArrowUp' && count) {
                  e.preventDefault();
                  return setQuickActive((i) => (i - 1 + count) % count);
                }
                if (((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') && count && !e.nativeEvent.isComposing) {
                  e.preventDefault(); // insert, don't send "/..."
                  return insertQuickReply(quick.items[Math.min(quickActive, count - 1)]);
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  return setQuickClosed(true);
                }
              }
              // Esc cancels the edit / reply first (marked handled, so it doesn't also leave the chat)
              if (e.key === 'Escape' && editing) {
                e.preventDefault();
                cancelEdit();
              } else if (e.key === 'Escape' && replyTo) {
                e.preventDefault();
                setReplyTo(null);
              }
              // Same form submit as before (send, or save an edit); Shift+Enter keeps its default new line
              if (enterAction({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing }) === 'send') {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={editing ? 'Edit message' : noting ? 'Write an internal note for your team…' : 'Type a message, or / for quick replies'}
            aria-label={noting ? 'Internal note' : 'Message'}
            className={`relative block w-full resize-none rounded-xl border bg-transparent px-4 py-2.5 text-xs leading-relaxed text-transparent caret-ink [font-kerning:none] [font-variant-ligatures:none] placeholder:text-faint outline-hidden transition selection:bg-primary/25 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
              noting
                ? 'border-warning-border focus:border-warning focus:ring-1 focus:ring-warning'
                : 'border-line focus:border-primary focus:ring-1 focus:ring-primary'
            }`}
          />
          </div>

          {/* Empty message box: microphone to record a voice note (like WhatsApp); otherwise Send */}
          {!text.trim() && !editing && !noting ? (
            <button
              type="button"
              onClick={() => {
                setError('');
                setEmojiOpen(false);
                setVoiceMode(true);
              }}
              title="Record a voice message"
              aria-label="Record a voice message"
              className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-on-primary shadow-xs transition hover:bg-primary-hover"
            >
              <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
              </svg>
            </button>
          ) : (
          <button
            type="submit"
            disabled={(!text.trim() && !(noting && noteFiles.length)) || busy}
            className="flex h-9 items-center justify-center gap-1.5 rounded-xl bg-primary px-4 text-xs font-semibold text-on-primary shadow-xs hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            <span>{editing ? (busy ? 'Saving…' : 'Save') : noting ? (busy ? 'Saving…' : 'Add note') : 'Send'}</span>
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="m3.4 20.4 17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.993.993 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z" />
            </svg>
          </button>
          )}
        </form>
        </>
        )}
        </>
        ))}
        {imageFile && <FileSendDialog file={imageFile} onSend={sendImageWithCaption} onClose={() => setImageFile(null)} />}
        {locationOpen && (
          <LocationDialog
            conversationId={conversation.id}
            replyToId={replyTo?.id}
            onClose={() => setLocationOpen(false)}
            onSent={(m) => {
              onSent(m);
              setReplyTo(null);
              setLocationOpen(false);
            }}
            onLiveStarted={(m, live) => {
              onSent(m);
              setLive(live);
              startWatching(live, setError); // this tab sends your position until it ends or you stop
              setLocationOpen(false);
            }}
          />
        )}
      </footer>

      {menu && (
        <MessageMenu
          anchor={menu.anchor}
          actions={messageActions(menu.message, viewer, canReact)}
          onAction={(action) => onAction(menu.message, action)}
          onClose={closeMenu}
        />
      )}
      {forwarding && <ForwardDialog message={forwarding} onClose={() => setForwarding(null)} />}
      {confirmDelete && (
        <ConfirmDeleteDialog busy={busy} onConfirm={doDelete} onCancel={() => setConfirmDelete(null)} />
      )}
      {confirmClear && <ConfirmClearDialog busy={clearing} onConfirm={doClear} onCancel={() => setConfirmClear(false)} />}
    </section>
  );
}

