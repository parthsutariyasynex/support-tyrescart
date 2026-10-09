'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API_URL, getToken } from '@/lib/api';
import {
  type Conversation,
  type Message,
  fetchConversations,
  fetchMessages,
  markConversationRead,
  sendTemplateMessage,
  sendTextMessage,
  simulateIncomingMessage,
  startConversation,
} from '@/lib/inbox';
import { AppShell } from '../AppShell';

const byLatest = (a: Conversation, b: Conversation) =>
  b.lastMessageAt.localeCompare(a.lastMessageAt) || b.id.localeCompare(a.id);

const STATUS_ICON: Record<string, string> = { pending: '🕓', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '⚠' };

export default function InboxPage() {
  return <AppShell>{() => <Inbox />}</AppShell>;
}

function Inbox() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [conversationsCursor, setConversationsCursor] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [loading, setLoading] = useState(false);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const loadedMoreRef = useRef(false); // true once "Load more" fetched pages past the first

  // Refresh the newest page. If older pages were loaded, merge so they stay in the list.
  const loadConversations = useCallback(() => {
    setLoading(true);
    return fetchConversations()
      .then((page) => {
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
      const page = await fetchConversations(conversationsCursor);
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

  useEffect(() => {
    loadConversations();
    const socket = io(API_URL, { auth: { token: getToken() } });
    socket.on('message:new', ({ message }: { message: Message }) => {
      if (message.conversationId === activeIdRef.current)
        setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
      loadConversations();
    });
    socket.on('message:status', (updated: Message) =>
      setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m))),
    );
    return () => {
      socket.disconnect();
    };
  }, [loadConversations]);

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false; // ignore late responses after switching chats
    setMessages([]);
    setOlderCursor(null);
    Promise.all([fetchMessages(activeId), markConversationRead(activeId)])
      .then(([page]) => {
        if (cancelled) return;
        setMessages(page.nodes);
        setOlderCursor(page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null);
        loadConversations();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeId, loadConversations]);

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

  const active = conversations.find((c) => c.id === activeId);

  const filteredConversations = conversations.filter((c) => {
    const term = searchQuery.toLowerCase();
    const name = (c.contact.name || '').toLowerCase();
    const phone = c.contact.waId.toLowerCase();
    const matchesSearch = name.includes(term) || phone.includes(term);
    if (filterType === 'unread') return matchesSearch && c.unread > 0;
    return matchesSearch;
  });

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* Left Conversations List Panel */}
      <ConversationList
        conversations={filteredConversations}
        totalCount={conversations.length}
        activeId={activeId}
        onSelect={setActiveId}
        onRefresh={loadConversations}
        onLoadMore={conversationsCursor ? loadMoreConversations : undefined}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        filterType={filterType}
        onFilterChange={setFilterType}
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
        />
      ) : (
        <EmptyChatState />
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
  loading,
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
  loading: boolean;
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
      <div className="px-3 py-1.5 border-b border-line-soft">
        <div className="relative">
          <select
            value={filterType}
            onChange={(e) => onFilterChange(e.target.value)}
            className="w-full appearance-none rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-body outline-hidden hover:border-line-strong focus:border-primary cursor-pointer"
          >
            <option value="all">All</option>
            <option value="unread">Unread</option>
          </select>
          <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-faint">
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
        </div>
      </div>

      {/* Conversation List / Empty State */}
      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 ? (
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
              {process.env.NODE_ENV !== 'production' && (
                <button
                  onClick={simulate}
                  className="w-full rounded-lg border border-dashed border-line-strong bg-surface-muted/50 py-1.5 px-3 text-xs text-body-soft hover:bg-surface-strong transition"
                >
                  ⚡ Simulate incoming message (dev)
                </button>
              )}
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-line-soft">
            {conversations.map((c) => {
              const contactName = c.contact.name || `+${c.contact.waId}`;
              const initial = contactName.charAt(0).toUpperCase();
              const isSelected = activeId === c.id;

              return (
                <li key={c.id}>
                  <button
                    onClick={() => onSelect(c.id)}
                    className={`flex w-full items-start gap-3 px-3.5 py-3 text-left transition ${
                      isSelected ? 'bg-primary-subtle' : 'hover:bg-surface-muted'
                    }`}
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-bold text-primary">
                      {initial}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between">
                        <span className={`truncate text-xs font-semibold ${isSelected ? 'text-primary' : 'text-ink'}`}>
                          {contactName}
                        </span>
                        <span className="text-[10px] text-faint">
                          {new Date(c.lastMessageAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[11px] text-muted">
                        {c.lastMessage?.body || 'No messages yet'}
                      </p>
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
}: {
  conversation: Conversation;
  messages: Message[];
  onLoadOlder?: () => void;
  onSent: (m: Message) => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  // Scroll only when a newer message arrives, not when older ones are prepended
  const lastId = messages.at(-1)?.id;
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

  const contactName = conversation.contact.name || `+${conversation.contact.waId}`;

  return (
    <section className="relative flex min-w-0 flex-1 flex-col bg-chat-bg">
      {/* Ambient Doodle Pattern */}
      <div
        className="pointer-events-none absolute inset-0 bg-chat-doodle opacity-[0.05]"
      />

      {/* Chat Top Header */}
      <header className="relative z-10 flex h-14 shrink-0 items-center justify-between border-b border-line/90 bg-surface px-5 shadow-2xs">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-soft text-xs font-bold text-primary">
            {contactName.charAt(0).toUpperCase()}
          </div>
          <div>
            <p className="text-xs font-bold text-ink">{contactName}</p>
            <p className="text-[11px] text-muted">+{conversation.contact.waId}</p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          {process.env.NODE_ENV !== 'production' && (
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
              title="Dev only: Fake customer reply from this number without webhook"
              className="rounded-full border border-dashed border-primary/40 bg-primary-subtle px-2.5 py-1 text-[11px] font-medium text-primary hover:bg-primary-soft transition"
            >
              ⚡ Simulate Reply
            </button>
          )}
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
        {messages.map((m) => {
          const isOut = m.direction === 'out';
          return (
            <div key={m.id} className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`relative max-w-[72%] rounded-2xl px-3.5 py-2 text-xs shadow-xs ${
                  isOut
                    ? 'rounded-tr-xs bg-bubble-out text-ink'
                    : 'rounded-tl-xs bg-bubble-in text-ink'
                }`}
              >
                <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{m.body}</p>
                <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-faint">
                  <span>{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  {isOut && (
                    <span className={m.status === 'read' ? 'text-tick-read font-bold' : m.status === 'failed' ? 'text-danger-icon' : 'text-faint'}>
                      {STATUS_ICON[m.status]}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Bottom Message Composer */}
      <footer className="relative z-10 border-t border-line/90 bg-surface p-3">
        {error && (
          <div className="mb-2 rounded-lg bg-danger-soft px-3 py-1.5 text-xs text-danger">{error}</div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
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
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a message"
            className="flex-1 rounded-xl border border-line bg-surface-muted/70 px-4 py-2.5 text-xs text-ink placeholder:text-faint outline-hidden transition focus:border-primary focus:bg-surface focus:ring-1 focus:ring-primary"
          />

          {/* Send Button */}
          <button
            type="submit"
            disabled={!text.trim()}
            className="flex h-9 items-center justify-center gap-1.5 rounded-xl bg-primary px-4 text-xs font-semibold text-on-primary shadow-xs hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            <span>Send</span>
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="m3.4 20.4 17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.993.993 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z" />
            </svg>
          </button>
        </form>
      </footer>
    </section>
  );
}

