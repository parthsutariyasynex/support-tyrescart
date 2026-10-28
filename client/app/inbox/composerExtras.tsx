'use client';

import type { EmojiStyle, SkinTonePickerLocation, SuggestionMode, Theme } from 'emoji-picker-react';
import dynamic from 'next/dynamic';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CAPTION_MAX, checkFile, documentLabel, downloadFile, formatSize, mediaUrl } from '@/lib/media';
import { overLimit, tooLongText } from '@/lib/textLimits';
import { ZoomableImage } from './ZoomableImage';

// The full Unicode emoji set (emoji-picker-react): search, categories, skin tones and recently used (kept in this
// browser by the picker). Its data ships with the package, so nothing is fetched from another site; and it's only
// loaded the first time a picker opens, not with the page.
const Picker = dynamic(() => import('emoji-picker-react'), {
  ssr: false,
  loading: () => <div className="h-[400px] w-[340px] max-w-[calc(100vw-2rem)] animate-pulse rounded-xl bg-surface-strong" aria-busy="true" aria-label="Loading emojis" />,
});

// The picker in the app's own colours (its CSS variables, set on the picker itself so they win over its defaults)
const PICKER_THEME = {
  '--epr-bg-color': 'var(--color-surface)',
  '--epr-text-color': 'var(--color-ink)',
  '--epr-picker-border-color': 'var(--color-line)',
  '--epr-highlight-color': 'var(--color-primary)',
  '--epr-category-icon-active-color': 'var(--color-primary)',
  '--epr-hover-bg-color': 'var(--color-surface-strong)',
  '--epr-focus-bg-color': 'var(--color-surface-strong)',
  '--epr-search-input-bg-color': 'var(--color-surface-muted)',
  '--epr-search-input-bg-color-active': 'var(--color-surface)',
  '--epr-search-border-color': 'var(--color-primary)',
  '--epr-category-label-bg-color': 'var(--color-surface)',
  '--epr-picker-border-radius': '12px',
} as React.CSSProperties;

const PICKER_WIDTH = 340;
const PICKER_HEIGHT = 400;

// Emoji picker (message box, reactions, automation replies). Drawn on top of the page (a portal), so no scrolling
// panel or header can cut it: above where it's opened when there's room, otherwise below, always on screen.
// Esc or a click outside closes it.
export function EmojiPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLSpanElement>(null); // where it opens from: the spot the picker used to take
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const box = anchorRef.current?.parentElement?.getBoundingClientRect();
      if (!box) return;
      const w = Math.min(PICKER_WIDTH, window.innerWidth - 32);
      const room = box.top - 8;
      const top = room >= PICKER_HEIGHT || box.top > window.innerHeight - box.bottom ? Math.max(8, box.top - PICKER_HEIGHT - 8) : Math.min(box.bottom + 8, window.innerHeight - PICKER_HEIGHT - 8);
      const left = Math.min(Math.max(8, box.left), window.innerWidth - w - 8);
      setPos({ top, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true); // follow what it opened from
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, []);

  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!ref.current?.contains(t) && !t.closest('[data-emoji-toggle]')) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <>
      <span ref={anchorRef} className="hidden" aria-hidden="true" />
      {createPortal(
        <div
          ref={ref}
          role="dialog"
          aria-label="Emojis"
          data-emoji-picker
          className="fixed z-[70] rounded-xl shadow-xl"
          style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
        >
          <Picker
            onEmojiClick={(e) => onPick(e.emoji)}
            emojiStyle={'native' as EmojiStyle}
            theme={'light' as Theme}
            suggestedEmojisMode={'recent' as SuggestionMode}
            skinTonePickerLocation={'SEARCH' as SkinTonePickerLocation}
            searchPlaceholder="Search emoji"
            autoFocusSearch
            lazyLoadEmojis
            previewConfig={{ showPreview: false }}
            width={`min(${PICKER_WIDTH}px, calc(100vw - 2rem))`}
            height={PICKER_HEIGHT}
            style={PICKER_THEME}
          />
        </div>,
        document.body,
      )}
    </>
  );
}

// Preview of the chosen image, or a card for a document, with an optional caption, then Send
export function FileSendDialog({
  file,
  onSend,
  onClose,
}: {
  file: File;
  onSend: (caption: string) => Promise<void>;
  onClose: () => void;
}) {
  const [url, setUrl] = useState('');
  const [caption, setCaption] = useState('');
  const checked = checkFile(file, { video: true });
  const kind = 'kind' in checked ? checked.kind : 'document';
  const isImage = kind === 'image';
  const title = kind === 'image' ? 'Send image' : kind === 'video' ? 'Send video' : 'Send document';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (kind === 'document') return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file, kind]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function send() {
    // Over WhatsApp's caption limit: kept as typed, not sent until it's shortened
    if (overLimit(caption, CAPTION_MAX)) return setError(tooLongText(caption, CAPTION_MAX, "WhatsApp allows a caption of up to"));
    setBusy(true);
    setError('');
    try {
      await onSend(caption);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/50 p-4" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div role="dialog" aria-label={title} className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-line-soft px-5 py-3">
          <h2 className="text-sm font-bold text-ink">{title}</h2>
          <span className="truncate pl-3 text-[11px] text-muted">
            {file.name} · {formatSize(file.size)}
          </span>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center bg-surface-muted p-4">
          {isImage ? (
            url && <img src={url} alt="Image to send" className="max-h-[50vh] max-w-full rounded-lg object-contain shadow-xs" />
          ) : kind === 'video' ? (
            url && <video src={url} controls preload="metadata" className="max-h-[50vh] max-w-full rounded-lg bg-ink shadow-xs" aria-label="Video to send" />
          ) : (
            <div className="flex w-full max-w-sm items-center gap-3 rounded-xl bg-surface px-4 py-3.5 shadow-xs">
              <DocIcon label={documentLabel('type' in checked ? checked.type : file.type, file.name)} />
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-ink" title={file.name}>
                  {file.name}
                </p>
                <p className="text-[11px] text-muted">
                  {documentLabel('type' in checked ? checked.type : file.type, file.name)} · {formatSize(file.size)}
                </p>
              </div>
            </div>
          )}
        </div>
        <div className="border-t border-line-soft p-4">
          <textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (!busy) send();
              }
            }}
            rows={2}
            autoFocus
            placeholder="Add a caption (optional)"
            aria-label="Caption"
            className="w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink outline-hidden placeholder:text-faint focus:border-primary focus:ring-1 focus:ring-primary"
          />
          {error && <p className="mt-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
          {!error && overLimit(caption, CAPTION_MAX) && (
            <p className="mt-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger" role="status">
              {tooLongText(caption, CAPTION_MAX, 'WhatsApp allows a caption of up to')}
            </p>
          )}
          <div className="mt-3 flex items-center justify-end gap-2">
            <button type="button" disabled={busy} onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-body-soft hover:bg-surface-muted disabled:opacity-50">
              Cancel
            </button>
            <button type="button" disabled={busy} onClick={send} className="rounded-lg bg-primary px-5 py-1.5 text-xs font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-60">
              {busy ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// An image message in a chat bubble: loaded with the sign-in token; click opens it full size
export function ChatImage({ messageId }: { messageId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [full, setFull] = useState(false);
  useEffect(() => {
    let cancelled = false;
    mediaUrl(messageId)
      .then((u) => !cancelled && setSrc(u))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  if (error) return <p className="py-1 text-[12px] italic text-muted">📷 {error}</p>;
  if (!src) return <div className="h-40 w-56 animate-pulse rounded-lg bg-surface-strong" aria-label="Loading image" />;
  return (
    <>
      <button type="button" onClick={() => setFull(true)} title="View full size" className="block overflow-hidden rounded-lg">
        <img src={src} alt="Image" className="max-h-64 max-w-[260px] object-cover" />
      </button>
      {full &&
        createPortal(
          <div className="fixed inset-0 z-[80] flex items-center justify-center bg-ink/80 p-6" role="dialog" aria-label="Image">
            {/* Zoom with the wheel, a pinch or a double-click/tap; a click beside the picture closes */}
            <ZoomableImage src={src} alt="Image, full size" onBackdropClick={() => setFull(false)} />
            <button type="button" onClick={() => setFull(false)} aria-label="Close" className="absolute right-5 top-5 z-10 rounded-full bg-ink/70 px-3 py-1.5 text-sm text-on-primary shadow-lg hover:bg-ink/90">
              ✕
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

// File-type badge for documents (PDF red, Word blue, Excel green, PowerPoint orange, text grey)
const DOC_COLOURS: Record<string, string> = { PDF: '#dc2626', DOC: '#2563eb', DOCX: '#2563eb', XLS: '#16a34a', XLSX: '#16a34a', PPT: '#ea580c', PPTX: '#ea580c' };
export function DocIcon({ label }: { label: string }) {
  return (
    <span className="relative flex h-11 w-9 shrink-0 items-end justify-center rounded-md border border-line bg-surface pb-1" aria-hidden="true">
      <span className="absolute right-0 top-0 h-2.5 w-2.5 rounded-bl-sm border-b border-l border-line bg-surface-muted" />
      <span className="rounded px-1 text-[8px] font-bold text-on-primary" style={{ backgroundColor: DOC_COLOURS[label] ?? '#64748b' }}>
        {label.slice(0, 4)}
      </span>
    </span>
  );
}

// A document message in a chat bubble: name, type and size; click downloads it under its own name
export function DocumentCard({ messageId, name, mime, size }: { messageId: string; name: string; mime: string | null | undefined; size: number | null | undefined }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const label = documentLabel(mime, name);
  return (
    <div className="w-64 max-w-full">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            await downloadFile(messageId, name);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
        title={`Download ${name}`}
        className="flex w-full items-center gap-3 rounded-lg bg-surface/70 px-3 py-2.5 text-left transition hover:bg-surface"
      >
        <DocIcon label={label} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-ink">{name}</span>
          <span className="block text-[11px] text-muted">
            {label}
            {size ? ` · ${formatSize(size)}` : ''}
          </span>
        </span>
        <svg className="h-4 w-4 shrink-0 text-body-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {busy ? <circle cx="12" cy="12" r="8" strokeDasharray="12 40" /> : <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />}
        </svg>
      </button>
      {error && <p className="mt-1 text-[11px] text-danger">{error}</p>}
    </div>
  );
}

// A video or audio/voice message in a chat bubble: loaded with the sign-in token, played in place
export function ChatPlayer({ messageId, kind }: { messageId: string; kind: 'video' | 'audio' }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    mediaUrl(messageId)
      .then((u) => !cancelled && setSrc(u))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [messageId]);
  if (error) return <p className="py-1 text-[12px] italic text-muted">{kind === 'video' ? '🎥' : '🎤'} {error}</p>;
  if (!src) return <div className={`animate-pulse rounded-lg bg-surface-strong ${kind === 'video' ? 'h-40 w-56' : 'h-10 w-60'}`} aria-label={`Loading ${kind}`} />;
  return kind === 'video' ? (
    <video src={src} controls preload="metadata" className="max-h-64 max-w-[260px] rounded-lg bg-ink" aria-label="Video" />
  ) : (
    <audio src={src} controls preload="metadata" className="w-60 max-w-full" aria-label="Audio" />
  );
}

// Full-screen view of any file from the Media tab: picture, video or audio player; documents download
export function MediaViewer({ file, onClose }: { file: { id: string; type: string; mediaName?: string | null; createdAt?: string }; onClose: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    mediaUrl(file.id)
      .then((u) => !cancelled && setSrc(u))
      .catch((e) => !cancelled && setError((e as Error).message));
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => {
      cancelled = true;
      document.removeEventListener('keydown', onKey);
    };
  }, [file.id, onClose]);
  if (typeof document === 'undefined') return null;
  const kind = file.type === 'image' || file.type === 'sticker' ? 'image' : file.type === 'video' ? 'video' : file.type === 'audio' || file.type === 'voice' ? 'audio' : 'other';
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-ink/85 p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-label="File viewer">
      <button type="button" onClick={onClose} aria-label="Close" className="absolute right-5 top-5 z-10 rounded-full bg-ink/70 px-3 py-1.5 text-sm text-on-primary shadow-lg hover:bg-ink/90">
        ✕
      </button>
      {error ? (
        <p className="rounded-lg bg-surface px-4 py-3 text-sm text-danger">{error}</p>
      ) : !src ? (
        <p className="text-sm text-on-primary/80">Loading…</p>
      ) : kind === 'image' ? (
        <ZoomableImage src={src} alt={file.mediaName ?? 'Image'} onBackdropClick={onClose} />
      ) : kind === 'video' ? (
        <video src={src} controls autoPlay className="max-h-full max-w-full rounded-lg bg-ink" aria-label="Video" />
      ) : kind === 'audio' ? (
        <div className="rounded-2xl bg-surface p-6">
          <audio src={src} controls autoPlay className="w-80" aria-label="Audio" />
        </div>
      ) : (
        <div className="rounded-2xl bg-surface p-6 text-center">
          <p className="text-sm font-semibold text-ink">{file.mediaName ?? 'File'}</p>
          <a href={src} download={file.mediaName ?? 'file'} className="mt-3 inline-block rounded-lg bg-primary px-4 py-1.5 text-xs font-semibold text-on-primary">
            Download
          </a>
        </div>
      )}
    </div>,
    document.body,
  );
}
