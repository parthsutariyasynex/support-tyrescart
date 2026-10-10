'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Message } from '@/lib/inbox';

const STATUS_ICON: Record<string, string> = { pending: '🕓', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '⚠' };
const LONG_PRESS_MS = 450;

// WhatsApp-group style: every agent gets their own name colour (stable per sender id); the customer uses the brand colour
const AGENT_NAME_COLORS = ['#128c7e', '#5e5ce6', '#9b51e0', '#d63384', '#c2410c', '#0369a1', '#4d7c0f', '#b45309'];
function agentColor(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AGENT_NAME_COLORS[h % AGENT_NAME_COLORS.length];
}

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export type MessageAction = 'copy' | 'edit' | 'delete';

// Which actions the viewer gets on a message. The API enforces the same rules; this only hides what would be refused.
export function messageActions(m: Message, viewer: { userId: string; isAdmin: boolean } | null): MessageAction[] {
  if (m.deletedAt) return [];
  const actions: MessageAction[] = m.body ? ['copy'] : [];
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
}: {
  message: Message;
  actions: MessageAction[];
  highlighted: boolean;
  onOpenMenu: (anchor: HTMLElement) => void;
}) {
  const isOut = m.direction === 'out';
  const bubbleRef = useRef<HTMLDivElement>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasActions = actions.length > 0;

  const cancelPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  return (
    <div className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}>
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
        } ${highlighted ? 'ring-2 ring-primary/40' : ''}`}
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

        {m.senderName && (
          <p
            className={`mb-0.5 truncate pr-4 text-[11px] font-semibold ${isOut ? '' : 'text-primary'}`}
            style={isOut && m.sentById ? { color: agentColor(m.sentById) } : undefined}
          >
            {m.senderName}
          </p>
        )}
        {m.deletedAt ? (
          <p className="pr-2 text-[13px] leading-relaxed">
            <DeletedText />
          </p>
        ) : (
          <p className="whitespace-pre-wrap break-words pr-3 text-[13px] leading-relaxed">{m.body}</p>
        )}
        <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-faint">
          {m.editedAt && !m.deletedAt && (
            <span title={`Edited ${new Date(m.editedAt).toLocaleString()}`} className="italic">
              Edited
            </span>
          )}
          <span>{time(m.createdAt)}</span>
          {isOut && !m.deletedAt && (
            <span
              className={
                m.status === 'read' ? 'text-tick-read font-bold' : m.status === 'failed' ? 'text-danger-icon' : 'text-faint'
              }
            >
              {STATUS_ICON[m.status]}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

const MENU_WIDTH = 200;

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
    const left = Math.min(Math.max(8, a.right - MENU_WIDTH), window.innerWidth - MENU_WIDTH - 8);
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
      style={sheet ? undefined : { width: MENU_WIDTH, top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      {sheet && <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-line-strong" />}
      {items
        .filter((i) => actions.includes(i.action))
        .map((i) => (
          <button
            key={i.action}
            role="menuitem"
            onClick={() => onAction(i.action)}
            className={`flex w-full items-center gap-2.5 rounded-lg text-left font-medium transition ${sheet ? 'px-3 py-3' : 'px-2.5 py-2'} ${
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

  return sheet ? (
    <>
      <div className="fixed inset-0 z-40 bg-shadow/30" onClick={onClose} />
      {menu}
    </>
  ) : (
    menu
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
