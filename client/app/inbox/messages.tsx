'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type Message, type QuotedMessage, QUICK_REACTIONS } from '@/lib/inbox';
import { forwardKind } from '@/lib/forward';
import { formatDateTime, formatTime } from '@/lib/time';
import { ChatImage, ChatPlayer, DocumentCard, EmojiPicker } from './composerExtras';
import { FormattedText } from './FormattedText';
import { LocationCard } from './LocationCard';
import { VoicePlayer } from './voice';
import { isMediaPlaceholder, quotePreview } from '@/lib/media';

const STATUS_ICON: Record<string, string> = { pending: '🕓', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '⚠' };
const LONG_PRESS_MS = 450;

// WhatsApp-group style: every agent gets their own name colour (stable per sender id); the customer uses the brand colour
const AGENT_NAME_COLORS = ['#128c7e', '#5e5ce6', '#9b51e0', '#d63384', '#c2410c', '#0369a1', '#4d7c0f', '#b45309'];
function agentColor(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AGENT_NAME_COLORS[h % AGENT_NAME_COLORS.length];
}

export type MessageAction = 'reply' | 'forward' | 'copy' | 'edit' | 'delete';

// Which actions the viewer gets on a message. The API enforces the same rules; this only hides what would be refused.
// canReply: whether the viewer may write in this chat (replying sends a message)
export function messageActions(m: Message, viewer: { userId: string; isAdmin: boolean } | null, canReply = false): MessageAction[] {
  if (m.deletedAt) return [];
  const actions: MessageAction[] = canReply && m.status !== 'pending' ? ['reply'] : [];
  // Forward to other chats: what this app can send (text, photos, documents, voice notes); their own rules apply there
  if (m.status !== 'pending' && forwardKind(m)) actions.push('forward');
  if (m.body) actions.push('copy');
  const mine = m.direction === 'out' && !!viewer && (viewer.isAdmin || m.sentById === viewer.userId);
  if (mine && m.type === 'text') actions.push('edit');
  if (mine) actions.push('delete');
  return actions;
}

function BanIcon() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
      <path d="m5.6 5.6 12.8 12.8" />
    </svg>
  );
}

// A quoted message, WhatsApp style: a coloured bar, who wrote it and one line of it. In a reply it jumps to the
// original when clicked; above the composer it shows what you're replying to.
export function QuoteBlock({ quote, onClick, className = '' }: { quote: QuotedMessage; onClick?: () => void; className?: string }) {
  const name = quote.senderName ?? (quote.direction === 'in' ? 'Customer' : 'Team');
  const inner = (
    <>
      <span className={`block truncate text-[11px] font-semibold ${quote.direction === 'in' ? 'text-primary' : 'text-[#5e5ce6]'}`}>{name}</span>
      <span className={`line-clamp-2 break-words text-[12px] ${quote.deleted ? 'italic text-faint' : 'text-body-soft'}`}>{quotePreview(quote)}</span>
    </>
  );
  const cls = `block w-full min-w-0 rounded-md border-l-4 bg-ink/5 px-2.5 py-1.5 text-left ${quote.direction === 'in' ? 'border-primary' : 'border-[#5e5ce6]'} ${className}`;
  return onClick ? (
    <button type="button" onClick={onClick} title="Go to the original message" className={`${cls} transition hover:bg-ink/10`}>
      {inner}
    </button>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

export function DeletedText({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 italic text-faint ${className}`}>
      <BanIcon />
      This message was deleted
    </span>
  );
}

// One chat bubble. Desktop: hover shows a ⌄ button (or right-click). Touch: long-press. Both open the actions menu.
export function MessageBubble({
  message: m,
  actions,
  highlighted,
  onOpenMenu,
  highlightTerm = '',
  currentMatch = false,
  onReact,
  onJumpTo,
  viewer = null,
}: {
  message: Message;
  actions: MessageAction[];
  // Who is looking (a live location's "Stop sharing" is for the person sharing, or an admin)
  viewer?: { userId: string; isAdmin: boolean } | null;
  // A reply: go to the message it quotes
  onJumpTo?: (messageId: string) => void;
  highlighted: boolean;
  onOpenMenu: (anchor: HTMLElement) => void;
  // React with an emoji (null removes the team's reaction); absent when you can't react to this message
  onReact?: (emoji: string | null) => void;
  // "Search in conversation": the text to mark inside the bubble, and whether this is the match being shown
  highlightTerm?: string;
  currentMatch?: boolean;
}) {
  const isOut = m.direction === 'out';
  const bubbleRef = useRef<HTMLDivElement>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasActions = actions.length > 0;
  const reactions = [m.customerReaction, m.teamReaction].filter((r): r is string => !!r);

  const cancelPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  return (
    <div className={`flex ${isOut ? 'justify-end' : 'justify-start'} ${reactions.length ? 'mb-3' : ''}`} data-message-id={m.id}>
      <div
        ref={bubbleRef}
        onContextMenu={(e) => {
          if (!hasActions || !bubbleRef.current) return;
          e.preventDefault();
          onOpenMenu(bubbleRef.current);
        }}
        onTouchStart={() => {
          if (!hasActions) return;
          cancelPress();
          pressTimer.current = setTimeout(() => bubbleRef.current && onOpenMenu(bubbleRef.current), LONG_PRESS_MS);
        }}
        onTouchEnd={cancelPress}
        onTouchMove={cancelPress}
        className={`group relative max-w-[72%] rounded-2xl px-3.5 py-2 text-xs shadow-xs transition [-webkit-touch-callout:none] ${
          isOut ? 'rounded-tr-xs bg-bubble-out text-ink' : 'rounded-tl-xs bg-bubble-in text-ink'
        } ${highlighted ? 'ring-2 ring-primary/40' : ''} ${currentMatch ? 'ring-2 ring-accent' : ''}`}
      >
        {hasActions && (
          <button
            type="button"
            aria-label="Message options"
            onClick={() => bubbleRef.current && onOpenMenu(bubbleRef.current)}
            className={`absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full text-faint opacity-0 transition hover:text-body group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:hidden ${
              isOut ? 'bg-bubble-out' : 'bg-bubble-in'
            } ${highlighted ? 'opacity-100' : ''}`}
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        )}

        {onReact && !m.deletedAt && <ReactionPicker isOut={isOut} current={m.teamReaction ?? null} onReact={onReact} />}
        {reactions.length > 0 && <ReactionBadge message={m} isOut={isOut} onRemove={onReact && m.teamReaction ? () => onReact(null) : undefined} />}

        {m.automation && !m.senderName && (
          <p className="mb-0.5 pr-4 text-[11px] font-semibold text-muted" title="Sent automatically (Settings → Simple automations)">
            {m.automation === 'follow_up' ? '🤖 Follow-up' : '🤖 Auto-reply'}
          </p>
        )}
        {m.senderName && (
          <p
            className={`mb-0.5 truncate pr-4 text-[11px] font-semibold ${isOut ? '' : 'text-primary'}`}
            style={isOut && m.sentById ? { color: agentColor(m.sentById) } : undefined}
          >
            {m.senderName}
          </p>
        )}
        {m.replyTo && !m.deletedAt && <QuoteBlock quote={m.replyTo} onClick={onJumpTo ? () => onJumpTo(m.replyTo!.id) : undefined} className="mb-1 mt-0.5" />}
        {m.deletedAt ? (
          <p className="pr-2 text-[13px] leading-relaxed">
            <DeletedText />
          </p>
        ) : (
          <>
          {/* Files (yours or the customer's): picture, player or document card; the caption under it */}
          {(m.type === 'image' || m.type === 'sticker') && m.mediaMime && (
            <div className="mb-1 mt-0.5">
              <ChatImage messageId={m.id} />
            </div>
          )}
          {m.type === 'video' && m.mediaMime && (
            <div className="mb-1 mt-0.5">
              <ChatPlayer messageId={m.id} kind="video" />
            </div>
          )}
          {(m.type === 'audio' || m.type === 'voice') && m.mediaMime && (
            <div className="mb-1 mt-0.5">
              <VoicePlayer messageId={m.id} />
            </div>
          )}
          {m.type === 'document' && m.mediaMime && (
            <div className="mb-1 mt-0.5">
              <DocumentCard messageId={m.id} name={m.mediaName || 'Document'} mime={m.mediaMime} size={m.mediaSize} />
            </div>
          )}
          {/* A location (pin or live): a map preview that opens the exact point in Google Maps / Apple Maps */}
          {(m.type === 'location' || m.type === 'live_location') && (
            <div className="mb-0.5 mt-0.5 pr-1">
              <LocationCard m={m} viewer={viewer} />
            </div>
          )}
          {m.type !== 'location' && m.type !== 'live_location' && (m.mediaMime ? m.body && !isMediaPlaceholder(m.body) : true) && (
          // WhatsApp formatting shown (bold, italic, lists…); links open in a new tab, search matches stay marked
          <FormattedText text={m.body} highlightTerm={highlightTerm} className="pr-3 text-[13px] leading-relaxed" />
          )}
          </>
        )}
        <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-faint">
          {m.editedAt && !m.deletedAt && (
            <span title={`Edited ${formatDateTime(m.editedAt)}`} className="italic">
              Edited
            </span>
          )}
          <span>{formatTime(m.createdAt)}</span>
          {isOut && !m.deletedAt && (
            <span
              className={
                m.status === 'read' ? 'text-tick-read font-bold' : m.status === 'failed' ? 'text-danger-icon' : 'text-faint'
              }
              title={m.status === 'failed' ? `Not delivered${m.error ? `: ${m.error}` : ''}` : m.status}
            >
              {STATUS_ICON[m.status]}
            </span>
          )}
        </div>
        {/* Why WhatsApp didn't take or deliver it, as WhatsApp said it */}
        {isOut && !m.deletedAt && m.status === 'failed' && (
          <p role="status" className="mt-0.5 text-right text-[10px] text-danger">
            Not delivered{m.error ? `: ${m.error}` : ''}
          </p>
        )}
      </div>
    </div>
  );
}

// 😊 beside the bubble on hover: a bar of quick reactions (and "+" for any emoji), like WhatsApp. Choosing the
// reaction you already gave removes it.
function ReactionPicker({ isOut, current, onReact }: { isOut: boolean; current: string | null; onReact: (emoji: string | null) => void }) {
  const [open, setOpen] = useState<'quick' | 'all' | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // The full picker is drawn on top of the page (outside this element): a click in it isn't a click outside
    const onPointer = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('[data-emoji-picker]') && setOpen(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const choose = (emoji: string) => {
    setOpen(null);
    onReact(emoji === current ? null : emoji);
  };
  return (
    <div ref={ref} className={`absolute top-1/2 z-20 -translate-y-1/2 ${isOut ? '-left-9' : '-right-9'}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => (o ? null : 'quick'))}
        aria-label="React to message"
        title="React"
        aria-expanded={!!open}
        className={`flex h-7 w-7 items-center justify-center rounded-full bg-surface text-body-soft shadow-xs transition hover:text-ink group-hover:opacity-100 [@media(hover:none)]:opacity-100 ${open ? 'opacity-100' : 'opacity-0'}`}
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M8.5 14.5s1.3 1.5 3.5 1.5 3.5-1.5 3.5-1.5M9 9.5h.01M15 9.5h.01" />
        </svg>
      </button>
      {open === 'quick' && (
        <div
          role="toolbar"
          aria-label="Reactions"
          className={`absolute bottom-full mb-2 flex items-center gap-0.5 rounded-full border border-line bg-surface px-1.5 py-1 shadow-xl ${isOut ? 'right-0' : 'left-0'}`}
        >
          {QUICK_REACTIONS.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => choose(e)}
              aria-label={`React with ${e}`}
              aria-pressed={current === e}
              className={`flex h-9 w-9 items-center justify-center rounded-full text-[22px] leading-none transition hover:scale-125 ${current === e ? 'bg-surface-strong' : ''}`}
            >
              {e}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setOpen('all')}
            aria-label="More reactions"
            title="More"
            className="ml-0.5 flex h-8 w-8 items-center justify-center rounded-full bg-surface-strong text-lg leading-none text-body-soft hover:text-ink"
          >
            +
          </button>
        </div>
      )}
      {open === 'all' && (
        <div className={`absolute bottom-full mb-2 ${isOut ? 'right-0' : 'left-0'}`}>
          <div className="relative">
            <EmojiPicker onPick={choose} onClose={() => setOpen(null)} />
          </div>
        </div>
      )}
    </div>
  );
}

// Under the bubble's corner, as in WhatsApp: the reactions it has (the customer's and the business's); clicking
// removes the team's reaction
function ReactionBadge({ message: m, isOut, onRemove }: { message: Message; isOut: boolean; onRemove?: () => void }) {
  const same = !!m.customerReaction && m.customerReaction === m.teamReaction;
  const who = [m.customerReaction && `Customer ${m.customerReaction}`, m.teamReaction && `Team ${m.teamReaction}`].filter(Boolean).join(' · ');
  const emojis = same ? [m.customerReaction!] : [m.customerReaction, m.teamReaction].filter((r): r is string => !!r);
  return (
    <button
      type="button"
      onClick={onRemove}
      disabled={!onRemove}
      aria-label={`Reactions: ${who}${onRemove ? '. Click to remove the team reaction' : ''}`}
      title={`${who}${onRemove ? ' · click to remove the team reaction' : ''}`}
      className={`absolute -bottom-3.5 z-10 flex items-center gap-0.5 rounded-full border border-line bg-surface px-1.5 py-0.5 text-[13px] leading-none shadow-xs disabled:cursor-default ${isOut ? 'right-2' : 'left-2'} ${onRemove ? 'hover:bg-surface-muted' : ''}`}
    >
      {emojis.map((e, i) => (
        <span key={i}>{e}</span>
      ))}
      {same && <span className="pl-0.5 text-[10px] font-semibold text-muted">2</span>}
    </button>
  );
}

// The menu is at least this wide and grows to fit its longest label ("Delete for everyone"), never cutting it
const MENU_WIDTH = 100;

// Popover next to the bubble on desktop; a bottom sheet on narrow screens
export function MessageMenu({
  anchor,
  actions,
  onAction,
  onClose,
}: {
  anchor: HTMLElement;
  actions: MessageAction[];
  onAction: (action: MessageAction) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [sheet, setSheet] = useState(false);

  useLayoutEffect(() => {
    if (window.innerWidth < 640) return setSheet(true);
    const a = anchor.getBoundingClientRect();
    const h = ref.current?.offsetHeight ?? 140;
    const w = ref.current?.offsetWidth ?? MENU_WIDTH; // its real width, labels included
    const left = Math.min(Math.max(8, a.right - w), window.innerWidth - w - 8);
    const top = a.top + 24 + h <= window.innerHeight - 8 ? a.top + 24 : Math.max(8, a.top - h - 4);
    setPos({ top, left });
  }, [anchor]);

  useEffect(() => {
    function onPointer(e: MouseEvent | TouchEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    function onScroll(e: Event) {
      const t = e.target;
      if (t instanceof Node && t.contains(anchor)) onClose();
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

  const items: { action: MessageAction; label: string; danger?: boolean; icon: React.ReactNode }[] = [
    {
      action: 'reply',
      label: 'Reply',
      icon: (
        <>
          <path d="m9 14-5-5 5-5" />
          <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
        </>
      ),
    },
    {
      action: 'forward',
      label: 'Forward',
      icon: (
        <>
          <path d="m15 14 5-5-5-5" />
          <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13" />
        </>
      ),
    },
    {
      action: 'copy',
      label: 'Copy',
      icon: (
        <>
          <rect width="13" height="13" x="9" y="9" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </>
      ),
    },
    {
      action: 'edit',
      label: 'Edit',
      icon: (
        <>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </>
      ),
    },
    {
      action: 'delete',
      label: 'Delete for everyone',
      danger: true,
      icon: (
        <>
          <path d="M3 6h18" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </>
      ),
    },
  ];

  const menu = (
    <div
      ref={ref}
      role="menu"
      aria-label="Message options"
      className={
        sheet
          ? 'fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border-t border-line bg-surface p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-sm shadow-xl'
          : 'fixed z-50 rounded-xl border border-line bg-surface p-1 text-xs shadow-lg'
      }
      style={
        sheet
          ? undefined
          : {
              width: 'max-content',
              minWidth: MENU_WIDTH,
              maxWidth: 'calc(100vw - 16px)',
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              visibility: pos ? 'visible' : 'hidden',
            }
      }
    >
      {sheet && <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-line-strong" />}
      {items
        .filter((i) => actions.includes(i.action))
        .map((i) => (
          <button
            key={i.action}
            role="menuitem"
            onClick={() => onAction(i.action)}
            className={`flex w-full items-center gap-2.5 whitespace-nowrap rounded-lg text-left font-medium transition ${sheet ? 'px-3 py-3' : 'px-2.5 py-2'} ${
              i.danger ? 'text-danger hover:bg-danger-soft' : 'text-body hover:bg-surface-muted'
            }`}
          >
            <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {i.icon}
            </svg>
            {i.label}
          </button>
        ))}
    </div>
  );

  // Portal to <body>, like the other popovers: nothing in the chat panel (its scrolling, stacking or clipping) can
  // hide or cut the menu
  return createPortal(
    sheet ? (
      <>
        <div className="fixed inset-0 z-40 bg-shadow/30" onClick={onClose} />
        {menu}
      </>
    ) : (
      menu
    ),
    document.body,
  );
}

export function ConfirmDeleteDialog({
  busy,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onCancel();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-shadow/40 p-4 sm:items-center" onClick={() => !busy && onCancel()}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-message-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl bg-surface p-5 text-ink-soft shadow-xl"
      >
        <h2 id="delete-message-title" className="text-sm font-bold text-ink">
          Delete message for everyone?
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Everyone on your team will see &ldquo;This message was deleted&rdquo; instead. The customer&apos;s WhatsApp
          keeps the message they already received.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            disabled={busy}
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-body-soft hover:bg-surface-strong disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            disabled={busy}
            onClick={onConfirm}
            className="rounded-lg bg-danger px-3 py-1.5 text-xs font-semibold text-on-primary hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Deleting…' : 'Delete for everyone'}
          </button>
        </div>
      </div>
    </div>
  );
}

export const UNDO_SECONDS = 5;

export const ASSIGNED_TOAST_SECONDS = 6;

// "This chat has been assigned to you by Parth." Same bar as UndoToast, shown at the bottom-left corner of the
// page for a few seconds when a chat is assigned, reassigned or unassigned. Click opens the chat.
export function AssignedToast({ message, detail, onOpen, onDone }: { message: string; detail?: string; onOpen: () => void; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, ASSIGNED_TOAST_SECONDS * 1000);
    return () => clearTimeout(t);
  }, [onDone]);
  if (typeof document === 'undefined') return null;

  // Portal to <body>: position: fixed is measured from the viewport, never from a transformed/scrolling panel.
  // Bottom-left corner, over the sidebar, so it never covers the message composer or the chat.
  return createPortal(
    <div role="status" className="pointer-events-none fixed bottom-20 left-4 z-[60] flex max-w-[calc(100vw-32px)] justify-start sm:left-6">
      <div className="pointer-events-auto flex w-96 max-w-full items-center gap-3 rounded-xl border border-on-primary/10 bg-ink px-3.5 py-2.5 text-xs text-on-primary shadow-2xl">
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left hover:underline">
          <span className="block font-semibold">{message}</span>
          {detail && <span className="block truncate text-on-primary/70">{detail}</span>}
        </button>
        <button type="button" onClick={onDone} title="Dismiss" className="rounded-md px-1.5 py-1 text-on-primary/70 hover:bg-on-primary/10 hover:text-on-primary">
          ✕
        </button>
      </div>
    </div>,
    document.body,
  );
}

// WhatsApp-style "Message deleted · Undo" bar with a countdown
export function UndoToast({ busy, onUndo, onDone }: { busy: boolean; onUndo: () => void; onDone: () => void }) {
  const [left, setLeft] = useState(UNDO_SECONDS);
  useEffect(() => {
    if (busy) return;
    if (left <= 0) return onDone();
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left, busy, onDone]);

  return (
    <div
      role="status"
      className="mb-2 flex items-center gap-3 overflow-hidden rounded-lg bg-ink px-3 py-2 text-xs text-on-primary shadow-lg"
    >
      <span className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-on-primary/30 text-[10px] font-bold">
        {left}
      </span>
      <span className="flex-1">Message deleted</span>
      <button
        type="button"
        disabled={busy}
        onClick={onUndo}
        className="rounded-md px-2 py-1 font-bold uppercase tracking-wide text-accent hover:bg-on-primary/10 disabled:opacity-60"
      >
        {busy ? 'Undoing…' : 'Undo'}
      </button>
    </div>
  );
}
