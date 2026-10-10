'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type Socket, io } from 'socket.io-client';
import { API_URL, getToken } from '@/lib/api';
import {
  type Conversation,
  type ConversationStatus,
  type Message,
  deleteMessage,
  editMessage,
  fetchConversation,
  fetchConversations,
  fetchMessages,
  markConversationRead,
  newerMessage,
  clearConversation,
  restoreMessage,
  setConversationStatus,
  sendTemplateMessage,
  sendTextMessage,
  simulateIncomingMessage,
  startConversation,
} from '@/lib/inbox';
import {
  type Activity,
  type NotificationFeed,
  activityText,
  fetchConversationActivity,
  fetchNotifications,
  fetchUnreadTotal,
  markNotificationsSeen,
} from '@/lib/activity';
import { type Assignee, fetchAssignees } from '@/lib/assignees';
import { type Label, type Permissions, fetchLabels, fetchPermissions } from '@/lib/labels';
import { AppShell } from '../AppShell';
import { AssignDropdown, AssigneeAvatar } from './assign';
import { ContactAvatar, contactDisplayName } from './avatar';
import { ChatOptionsMenu, ClearIcon, CloseIcon, ConfirmClearDialog } from './chatOptions';
import { LabelChips, LabelPicker, TagIcon } from './labels';
import { NotificationBell, playPing, showDesktopNotification, unlockSound } from './notifications';
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
  UndoToast,
  messageActions,
} from './messages';

const byLatest = (a: Conversation, b: Conversation) =>
  b.lastMessageAt.localeCompare(a.lastMessageAt) || b.id.localeCompare(a.id);

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

type LabelRef = Conversation['labels'][number];
// Which conversation the label picker is for (null = just manage labels) and the button it opened from
type PickerTarget = { conversationId: string | null; anchor: HTMLElement };


export default function InboxPage() {
  return <AppShell>{() => <Inbox />}</AppShell>;
}

type ConversationFilter = { labelId: string | null; assignee: string | null };
const filterKey = (f: ConversationFilter) => `${f.labelId}|${f.assignee}`;
type StatusChange = Pick<Conversation, 'status' | 'closedAt' | 'closedById'> & { conversationId: string };

function Inbox() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [conversationsCursor, setConversationsCursor] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [loading, setLoading] = useState(false);
  const [labels, setLabels] = useState<Label[]>([]);
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  // Who may create/edit/delete labels and assignees; null until loaded (treated as "can't")
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const permissionsRef = useRef(permissions);
  // Activity timeline of the open chat, the header bell, and unread total for the tab title
  const [activity, setActivity] = useState<Activity[]>([]);
  const [feed, setFeed] = useState<NotificationFeed | null>(null);
  const [unreadTotal, setUnreadTotal] = useState(0);
  permissionsRef.current = permissions;
  const canManage = !!permissions?.canManageLabels;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  // filterType is 'all' | 'unread' | 'label:<id>' | 'assigned:unassigned' | 'assigned:<assigneeId>'.
  // Label and assignee filters are applied by the API.
  const labelFilter = filterType.startsWith('label:') ? filterType.slice(6) : null;
  const assigneeFilter = filterType.startsWith('assigned:') ? filterType.slice(9) : null;
  const filterRef = useRef<ConversationFilter>({ labelId: labelFilter, assignee: assigneeFilter });
  filterRef.current = { labelId: labelFilter, assignee: assigneeFilter };
  // Keeps the open chat visible when a filter or edit drops it from the list
  const lastActiveRef = useRef<Conversation | null>(null);

  const loadedMoreRef = useRef(false); // true once "Load more" fetched pages past the first
  const loadSeqRef = useRef(0); // only the most recently started refresh may update the list

  // Refresh the newest page. If older pages were loaded, merge so they stay in the list.
  const loadConversations = useCallback(() => {
    setLoading(true);
    const filter = filterRef.current;
    const seq = ++loadSeqRef.current;
    return fetchConversations(null, filter)
      .then((page) => {
        if (filterKey(filter) !== filterKey(filterRef.current)) return; // filter changed while loading
        if (seq !== loadSeqRef.current) return; // a newer refresh started; this one may hold stale data
        if (!loadedMoreRef.current) {
          setConversations(page.nodes);
          setConversationsCursor(page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null);
          return;
        }
        setConversations((prev) => {
          const fresh = new Set(page.nodes.map((c) => c.id));
          return [...page.nodes, ...prev.filter((c) => !fresh.has(c.id))].sort(byLatest);
        });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const loadMoreConversations = useCallback(async () => {
    if (!conversationsCursor) return;
    setLoading(true);
    try {
      const filter = filterRef.current;
      const page = await fetchConversations(conversationsCursor, filter);
      if (filterKey(filter) !== filterKey(filterRef.current)) return;
      loadedMoreRef.current = true;
      setConversations((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...page.nodes.filter((c) => !seen.has(c.id))];
      });
      setConversationsCursor(page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [conversationsCursor]);

  const loadLabels = useCallback(() => {
    fetchLabels()
      .then(setLabels)
      .catch(() => {});
  }, []);

  const patchConversations = useCallback((fn: (c: Conversation) => Conversation) => {
    setConversations((prev) => prev.map(fn));
    if (lastActiveRef.current) lastActiveRef.current = fn(lastActiveRef.current);
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

  const loadAssignees = useCallback(() => {
    fetchAssignees()
      .then(setAssignees)
      .catch(() => {});
  }, []);

  // Shared by the Assign dropdown (own changes) and Socket.IO (changes from other agents)
  const onAssigned = useCallback(
    (conversationId: string, assignee: Conversation['assignee']) => {
      const ref = assignee && { id: assignee.id, name: assignee.name, color: assignee.color };
      patchConversations((c) => (c.id === conversationId ? { ...c, assignee: ref } : c));
      loadAssignees(); // counts changed
      if (filterRef.current.assignee) loadConversations(); // may have joined the filtered list
    },
    [patchConversations, loadAssignees, loadConversations],
  );

  const onAssigneeSaved = useCallback(
    (assignee: Assignee) => {
      setAssignees((prev) => [...prev.filter((a) => a.id !== assignee.id), assignee].sort(byName));
      patchConversations((c) =>
        c.assignee?.id === assignee.id
          ? { ...c, assignee: { id: assignee.id, name: assignee.name, color: assignee.color } }
          : c,
      );
    },
    [patchConversations],
  );

  // The server unassigns their chats too
  const onAssigneeDeleted = useCallback(
    (id: string) => {
      setAssignees((prev) => prev.filter((a) => a.id !== id));
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
    },
    [patchConversations],
  );

  // Closed or reopened here, or (via Socket.IO) by another agent. The chat stays in the list;
  // messages, labels and assignee are untouched.
  const onStatusChanged = useCallback(
    ({ conversationId, status, closedAt, closedById }: StatusChange) => {
      patchConversations((c) => (c.id === conversationId ? { ...c, status, closedAt, closedById } : c));
    },
    [patchConversations],
  );

  // Cleared (for this user only) here or in another of their tabs: empty the chat view and the list preview
  const onCleared = useCallback(
    (conversationId: string) => {
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
      setActiveId(id);
      setReopenError(null);
      const c = conversations.find((x) => x.id === id);
      if (c?.status !== 'closed') return;
      setConversationStatus(id, 'open')
        .then((r) => onStatusChanged({ conversationId: r.id, status: r.status, closedAt: r.closedAt, closedById: r.closedById }))
        .catch((err) => setReopenError({ id, message: (err as Error).message }));
    },
    [conversations, onStatusChanged],
  );

  // Changing the filter starts over from the newest page
  useEffect(() => {
    loadedMoreRef.current = false;
    setConversationsCursor(null);
    loadConversations();
  }, [labelFilter, assigneeFilter, loadConversations]);

  // AppShell's top header leaves a slot for page controls
  useEffect(() => setHeaderSlot(document.getElementById('app-header-actions')), []);

  useEffect(() => {
    fetchPermissions()
      .then(setPermissions)
      .catch(() => {});
  }, []);

  const loadFeed = useCallback(() => {
    fetchNotifications()
      .then(setFeed)
      .catch(() => {});
  }, []);
  const loadUnreadTotal = useCallback(() => {
    fetchUnreadTotal()
      .then(setUnreadTotal)
      .catch(() => {});
  }, []);

  // Open a chat from the bell or a desktop pop-up, even if it isn't in the loaded part of the list
  const openConversation = useCallback(
    (id: string) => {
      if (!conversationsRef.current.some((c) => c.id === id))
        fetchConversation(id)
          .then((c) => {
            lastActiveRef.current = c;
            setActiveId(id);
          })
          .catch(() => {});
      else setActiveId(id);
    },
    [],
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
    const socket = io(API_URL, { auth: { token: getToken() } });
    socketRef.current = socket;
    socket.on('typing', (e: TypingEvent) => {
      if (e.userId === permissionsRef.current?.userId) return; // yourself in another tab
      setTyping((s) => applyTypingEvent(s, e));
    });
    socket.on('message:new', ({ conversation, message }: { conversation: Conversation; message: Message }) => {
      if (message.conversationId === activeIdRef.current)
        setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
      loadConversations();
      loadUnreadTotal();
      // Customer wrote while this tab is in the background: sound + desktop pop-up
      if (message.direction === 'in' && document.hidden) {
        playPing();
        const name = conversation?.contact ? conversation.contact.name || `+${conversation.contact.waId}` : 'New message';
        showDesktopNotification(name, message.body || 'New message', message.conversationId, () =>
          openConversation(message.conversationId),
        );
      }
    });
    socket.on('activity:new', (a: Activity) => {
      if (a.conversationId && a.conversationId === activeIdRef.current && a.type !== 'message_received')
        setActivity((prev) => (prev.some((x) => x.id === a.id) ? prev : [...prev, a]));
      if (a.actorId === null || a.actorId !== permissionsRef.current?.userId)
        setFeed((f) => (f && !f.items.some((x) => x.id === a.id) ? { unseen: f.unseen + 1, items: [a, ...f.items].slice(0, 30) } : f));
    });
    socket.on('conversation:status', onStatusChanged);
    socket.on('conversation:cleared', ({ conversationId, userId }: { conversationId: string; userId: string }) => {
      if (userId === permissionsRef.current?.userId) onCleared(conversationId);
    });
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
      ({ conversationId, assignee }: { conversationId: string; assignee: Conversation['assignee'] }) =>
        onAssigned(conversationId, assignee),
    );
    socket.on('assignee:saved', onAssigneeSaved);
    socket.on('assignee:deleted', ({ id }: { id: string }) => onAssigneeDeleted(id));
    // An owner/admin granted or removed this user's label-management permission
    socket.on('member:permissions', ({ userId, role, canManageLabels }: Permissions) => {
      if (userId === permissionsRef.current?.userId) setPermissions({ userId, role, canManageLabels });
    });
    return () => {
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
  ]);

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false; // ignore late responses after switching chats
    setMessages([]);
    setActivity([]);
    setOlderCursor(null);
    Promise.all([fetchMessages(activeId), markConversationRead(activeId)])
      .then(([page]) => {
        if (cancelled) return;
        setMessages(page.nodes);
        setOlderCursor(page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null);
        loadConversations();
        loadUnreadTotal();
      })
      .catch(() => {});
    fetchConversationActivity(activeId)
      .then((items) => !cancelled && setActivity(items))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeId, loadConversations, loadUnreadTotal]);

  async function loadOlderMessages() {
    if (!activeId || !olderCursor) return;
    try {
      const page = await fetchMessages(activeId, olderCursor);
      setMessages((prev) => [...page.nodes.filter((m) => !prev.some((p) => p.id === m.id)), ...prev]);
      setOlderCursor(page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  const listed = conversations.find((c) => c.id === activeId);
  if (listed) lastActiveRef.current = listed;
  const active = listed ?? (lastActiveRef.current?.id === activeId ? lastActiveRef.current : undefined);

  const filteredConversations = conversations.filter((c) => {
    const term = searchQuery.toLowerCase();
    const name = (c.contact.name || '').toLowerCase();
    const phone = c.contact.waId.toLowerCase();
    const matchesSearch = name.includes(term) || phone.includes(term);
    if (filterType === 'unread') return matchesSearch && c.unread > 0;
    if (labelFilter) return matchesSearch && c.labels.some((l) => l.id === labelFilter);
    if (assigneeFilter === 'unassigned') return matchesSearch && !c.assignee;
    if (assigneeFilter) return matchesSearch && c.assignee?.id === assigneeFilter;
    return matchesSearch;
  });

  const openPicker = (conversationId: string | null, anchor: HTMLElement) =>
    setPicker((p) => (p?.anchor === anchor ? null : { conversationId, anchor }));
  const pickerConversation = picker?.conversationId
    ? (conversations.find((c) => c.id === picker.conversationId) ??
      (active?.id === picker.conversationId ? active : undefined))
    : undefined;

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* Left Conversations List Panel */}
      <ConversationList
        conversations={filteredConversations}
        totalCount={conversations.length}
        activeId={activeId}
        onSelect={selectConversation}
        onRefresh={loadConversations}
        onLoadMore={conversationsCursor ? loadMoreConversations : undefined}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        filterType={filterType}
        onFilterChange={setFilterType}
        labels={labels}
        assignees={assignees}
        typing={typing}
        onOpenLabels={openPicker}
        pickerConversationId={picker?.conversationId}
        loading={loading}
      />

      {/* Right Chat Panel with WhatsApp Doodle Background */}
      {active ? (
        <ChatPanel
          key={active.id}
          conversation={active}
          messages={messages}
          onLoadOlder={olderCursor ? loadOlderMessages : undefined}
          onSent={(m) => setMessages((p) => (p.some((x) => x.id === m.id) ? p : [...p, m]))}
          onOpenLabels={(anchor) => openPicker(active.id, anchor)}
          viewer={permissions && { userId: permissions.userId, isAdmin: ['owner', 'admin'].includes(permissions.role) }}
          onMessageUpdated={onMessageUpdated}
          onStatusChanged={onStatusChanged}
          onClosed={() => setActiveId(null)}
          onCleared={() => onCleared(active.id)}
          reopenError={reopenError?.id === active.id ? reopenError.message : null}
          typingNames={typingNames(typing, active.id)}
          activity={activity}
          meId={permissions?.userId ?? null}
          onTyping={(isTyping) => sendTyping(active.id, isTyping)}
        />
      ) : (
        <EmptyChatState />
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
            canManage={canManage}
            onAssigned={onAssigned}
            onAssigneeSaved={onAssigneeSaved}
            onAssigneeDeleted={onAssigneeDeleted}
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
  onLoadMore,
  searchQuery,
  onSearchChange,
  filterType,
  onFilterChange,
  labels,
  assignees,
  onOpenLabels,
  pickerConversationId,
  loading,
  typing,
}: {
  conversations: Conversation[];
  totalCount: number;
  activeId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  onLoadMore?: () => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  filterType: string;
  onFilterChange: (f: string) => void;
  labels: Label[];
  assignees: Assignee[];
  onOpenLabels: (conversationId: string | null, anchor: HTMLElement) => void;
  pickerConversationId?: string | null;
  loading: boolean;
  typing: TypingState;
}) {
  async function newChat() {
    const waId = prompt('Customer WhatsApp number with country code (e.g. 919876543210)');
    if (!waId) return;
    try {
      const c = await startConversation(waId.replace(/\D/g, ''));
      onRefresh();
      onSelect(c.id);
    } catch (err) {
      alert((err as Error).message);
    }
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
    <section className="flex w-72 sm:w-80 shrink-0 flex-col border-r border-line/90 bg-surface">
      {/* Top Header Metrics + Refresh Button */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2 text-xs text-muted">
        <span className="font-medium text-body-soft">
          {conversations.length} of {totalCount} · 0s
        </span>
        <button
          onClick={onRefresh}
          title="Refresh conversations"
          className={`flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-surface-strong hover:text-body transition ${loading ? 'animate-spin text-primary' : ''}`}
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
            <path d="M16 21h5v-5" />
          </svg>
        </button>
      </div>

      {/* Search Input */}
      <div className="px-3 py-1">
        <div className="relative">
          <input
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search name, number, message"
            className="w-full rounded-lg border border-line bg-surface-muted/70 px-3 py-1.5 text-xs text-ink-soft placeholder:text-faint outline-hidden transition hover:bg-surface focus:border-primary focus:bg-surface focus:ring-1 focus:ring-primary"
          />
          {searchQuery && (
            <button
              onClick={() => onSearchChange('')}
              className="absolute inset-y-0 right-0 pr-2 flex items-center text-faint hover:text-body-soft text-xs"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Filter Dropdown */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-line-soft">
        <div className="relative min-w-0 flex-1">
          <select
            value={filterType}
            onChange={(e) => onFilterChange(e.target.value)}
            className="w-full appearance-none rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-body outline-hidden hover:border-line-strong focus:border-primary cursor-pointer"
          >
            <option value="all">All</option>
            <option value="unread">Unread</option>
            <optgroup label="Assigned">
              <option value="assigned:unassigned">Unassigned</option>
              {assignees.map((a) => (
                <option key={a.id} value={`assigned:${a.id}`}>
                  {a.name} ({a.conversationCount})
                </option>
              ))}
            </optgroup>
            {labels.length > 0 && (
              <optgroup label="Labels">
                {labels.map((l) => (
                  <option key={l.id} value={`label:${l.id}`}>
                    {l.name} ({l.conversationCount})
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-faint">
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
        </div>
        {/* <button
          onClick={(e) => onOpenLabels(null, e.currentTarget)}
          title="Manage labels"
          className={`flex h-7.5 w-7.5 shrink-0 items-center justify-center rounded-lg border border-line text-faint hover:border-line-strong hover:text-body transition ${pickerConversationId === null ? 'border-primary text-primary' : ''}`}
        >
          <TagIcon />
        </button> */}
      </div>

      {/* Conversation List / Empty State */}
      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 && filterType !== 'all' ? (
          <p className="p-5 text-xs leading-relaxed text-muted">No conversations match this filter.</p>
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
            {conversations.map((c) => {
              const contactName = contactDisplayName(c.contact);
              const isSelected = activeId === c.id;

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
                        <span className={`truncate text-xs font-semibold ${isSelected ? 'text-primary' : 'text-ink'}`}>
                          {contactName}
                        </span>
                        <span className="text-[10px] text-faint">
                          {new Date(c.lastMessageAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      {typingNames(typing, c.id).length > 0 ? (
                        <p className="mt-0.5 truncate text-[11px] font-medium text-accent">typing…</p>
                      ) : (
                        <p className="mt-0.5 truncate text-[11px] text-muted">
                          {c.lastMessage?.deletedAt ? <DeletedText /> : c.lastMessage?.body || 'No messages yet'}
                        </p>
                      )}
                      {(c.labels.length > 0 || c.assignee) && (
                        <div className="mt-1 flex min-w-0 items-center gap-1.5">
                          {c.assignee && (
                            <span
                              title={`Assigned to ${c.assignee.name}`}
                              className="inline-flex max-w-24 shrink-0 items-center gap-1 text-[10px] font-medium text-body-soft"
                            >
                              <AssigneeAvatar assignee={c.assignee} size="h-3.5 w-3.5 text-[8px]" />
                              <span className="truncate">{c.assignee.name}</span>
                            </span>
                          )}
                          <LabelChips labels={c.labels} max={2} />
                        </div>
                      )}
                    </div>
                    {c.unread > 0 && (
                      <span className="flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-on-primary">
                        {c.unread}
                      </span>
                    )}
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
    <section className="relative flex-1 bg-chat-bg overflow-hidden">
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
  onLoadOlder,
  onSent,
  onOpenLabels,
  viewer,
  onMessageUpdated,
  onStatusChanged,
  onClosed,
  onCleared,
  reopenError,
  typingNames: typers,
  onTyping,
  activity,
  meId,
}: {
  conversation: Conversation;
  messages: Message[];
  onLoadOlder?: () => void;
  onSent: (m: Message) => void;
  onOpenLabels: (anchor: HTMLElement) => void;
  viewer: { userId: string; isAdmin: boolean } | null;
  onMessageUpdated: (m: Message) => void;
  onStatusChanged: (change: StatusChange) => void;
  // Called once this agent's "Close chat" succeeded: leave the chat and go back to the inbox list
  onClosed: () => void;
  // "Clear chat" succeeded (for this user only)
  onCleared: () => void;
  // Opening a closed chat reopens it; this is set if that failed
  reopenError: string | null;
  // Other agents typing in this chat right now
  typingNames: string[];
  onTyping: (typing: boolean) => void;
  // This chat's history (closed, assigned, labelled, edited…), shown between the messages
  activity: Activity[];
  meId: string | null;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Message actions: open menu, message being edited in the composer, message awaiting delete confirmation
  const [menu, setMenu] = useState<{ message: Message; anchor: HTMLElement } | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Message | null>(null);
  // Just deleted by this agent: offered for undo for a few seconds
  const [undo, setUndo] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const typingSender = useTypingSender(onTyping);
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
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  }

  async function changeStatus(status: ConversationStatus) {
    setStatusBusy(true);
    setError('');
    try {
      const c = await setConversationStatus(conversation.id, status);
      onStatusChanged({ conversationId: c.id, status: c.status, closedAt: c.closedAt, closedById: c.closedById });
      // Only after the server confirmed: exit the chat (on failure we stay here and show the error)
      if (status === 'closed') onClosed();
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
    if (action === 'copy') {
      navigator.clipboard?.writeText(m.body).catch(() => setError("Couldn't copy to the clipboard"));
    } else if (action === 'edit') {
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

  // Messages and activity in time order. While older messages aren't loaded yet, skip activity older than the
  // first loaded message so events don't pile up at the top.
  const oldestLoaded = onLoadOlder && messages[0] ? messages[0].createdAt : null;
  const stream = [
    ...messages.map((m) => ({ kind: 'message' as const, at: m.createdAt, id: m.id, m })),
    ...activity
      .filter((a) => !oldestLoaded || a.createdAt >= oldestLoaded)
      .map((a) => ({ kind: 'activity' as const, at: a.createdAt, id: a.id, a })),
  ].sort((x, y) => x.at.localeCompare(y.at));

  // Scroll only when something newer arrives, not when older messages are prepended
  const lastId = stream.at(-1)?.id;
  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [lastId]);

  async function send(input: { type: 'text'; body: string } | { type: 'template'; name: string; language?: string }) {
    setError('');
    try {
      onSent(
        input.type === 'text'
          ? await sendTextMessage(conversation.id, input.body)
          : await sendTemplateMessage(conversation.id, input.name, input.language),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // The customer this chat is with (never the logged-in agent)
  const contactName = contactDisplayName(conversation.contact);

  return (
    <section className="relative flex min-w-0 flex-1 flex-col bg-chat-bg">
      {/* Ambient Doodle Pattern */}
      <div
        className="pointer-events-none absolute inset-0 bg-chat-doodle opacity-[0.05]"
      />

      {/* Chat Top Header (above the message stream so its ⋮ menu opens on top of the messages) */}
      <header className="relative z-20 flex h-14 shrink-0 items-center justify-between border-b border-line/90 bg-surface px-5 shadow-2xs">
        <div className="flex min-w-0 items-center gap-3">
          <ContactAvatar contact={conversation.contact} size="h-9 w-9 text-xs" />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <p title={contactName} className="min-w-0 truncate text-xs font-bold text-ink">
                {contactName}
              </p>
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
                {conversation.assignee && <span> · Assigned to {conversation.assignee.name}</span>}
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          <button
            onClick={(e) => onOpenLabels(e.currentTarget)}
            title="Label chat"
            className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] font-medium text-body-soft hover:bg-surface-strong hover:text-body transition"
          >
            <TagIcon className="h-3 w-3" />
            <span>{conversation.labels.length > 0 ? `Labels (${conversation.labels.length})` : 'Label'}</span>
          </button>
          {!isClosed && (
            <ChatOptionsMenu
              disabled={statusBusy}
              busy={statusBusy}
              options={[
                { label: 'Clear chat', icon: ClearIcon, onSelect: () => setConfirmClear(true) },
                { label: 'Close chat', icon: CloseIcon, onSelect: () => changeStatus('closed') },
              ]}
            />
          )}
          {/* {process.env.NODE_ENV !== 'production' && (
            <button
              onClick={async () => {
                const body = prompt('Enter simulated reply text:', 'Hi support-tyrescart! I want to check prices for my car.');
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

      {/* Messages Stream */}
      <div className="relative z-10 flex-1 space-y-2.5 overflow-y-auto px-6 py-4">
        {onLoadOlder && (
          <div className="flex justify-center">
            <button
              onClick={onLoadOlder}
              className="rounded-full bg-surface/90 px-3 py-1 text-[11px] font-medium text-body-soft shadow-xs hover:bg-surface transition"
            >
              Load earlier messages
            </button>
          </div>
        )}
        {stream.map((item) => {
          if (item.kind === 'activity')
            return (
              <div key={item.id} className="flex justify-center">
                <span className="rounded-full bg-surface/90 px-3 py-1 text-center text-[11px] text-muted shadow-2xs">
                  {activityText(item.a, meId, 'chat')} ·{' '}
                  {new Date(item.a.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            );
          const m = item.m;
          const actions = messageActions(m, viewer);
          return (
            <MessageBubble
              key={m.id}
              message={m}
              actions={actions}
              highlighted={menu?.message.id === m.id || editing?.id === m.id}
              onOpenMenu={(anchor) => setMenu({ message: m, anchor })}
            />
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Bottom Message Composer */}
      <footer className="relative z-10 border-t border-line/90 bg-surface p-3">
        {error && (
          <div className="mb-2 rounded-lg bg-danger-soft px-3 py-1.5 text-xs text-danger">{error}</div>
        )}

        {undo && <UndoToast key={undo.id} busy={busy} onUndo={doUndo} onDone={clearUndo} />}

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

        {isClosed && !editing ? (
          <p className="rounded-xl bg-surface-muted px-4 py-2.5 text-center text-xs text-muted">
            {reopenError
              ? `Couldn't reopen this chat: ${reopenError}. Click it in the chat list to try again.`
              : 'This chat is closed. Click it in the chat list to reopen it.'}
          </p>
        ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            typingSender.stop();
            if (editing) return void saveEdit();
            if (!text.trim()) return;
            send({ type: 'text', body: text });
            setText('');
          }}
          className="flex items-center gap-2"
        >
          {/* Emoji Button */}
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-xl text-faint hover:bg-surface-strong hover:text-body-soft transition"
            title="Add emoji"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M8 14s1.5 2 4 2 4-2 4-2" />
              <line x1="9" y1="9" x2="9.01" y2="9" />
              <line x1="15" y1="9" x2="15.01" y2="9" />
            </svg>
          </button>

          {/* Attachment Paperclip Button */}
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-xl text-faint hover:bg-surface-strong hover:text-body-soft transition"
            title="Attach media"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>

          {/* Main Message Input */}
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              typingSender.onInput(e.target.value);
            }}
            onBlur={typingSender.stop}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && editing) cancelEdit();
            }}
            placeholder={editing ? 'Edit message' : 'Type a message'}
            className="flex-1 rounded-xl border border-line bg-surface-muted/70 px-4 py-2.5 text-xs text-ink placeholder:text-faint outline-hidden transition focus:border-primary focus:bg-surface focus:ring-1 focus:ring-primary"
          />

          {/* Send Button */}
          <button
            type="submit"
            disabled={!text.trim() || busy}
            className="flex h-9 items-center justify-center gap-1.5 rounded-xl bg-primary px-4 text-xs font-semibold text-on-primary shadow-xs hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            <span>{editing ? (busy ? 'Saving…' : 'Save') : 'Send'}</span>
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="m3.4 20.4 17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.993.993 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z" />
            </svg>
          </button>
        </form>
        )}
      </footer>

      {menu && (
        <MessageMenu
          anchor={menu.anchor}
          actions={messageActions(menu.message, viewer)}
          onAction={(action) => onAction(menu.message, action)}
          onClose={closeMenu}
        />
      )}
      {confirmDelete && (
        <ConfirmDeleteDialog busy={busy} onConfirm={doDelete} onCancel={() => setConfirmDelete(null)} />
      )}
      {confirmClear && <ConfirmClearDialog busy={clearing} onConfirm={doClear} onCancel={() => setConfirmClear(false)} />}
    </section>
  );
}

