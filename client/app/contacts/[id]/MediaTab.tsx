'use client';

import { useEffect, useState } from 'react';
import { type ChatFile, MEDIA_FILTERS, MEDIA_SORTS, fetchChatFiles, fileLabel, filterSortFiles } from '@/lib/contacts';
import { downloadFile, formatSize, mediaUrl } from '@/lib/media';
import { formatDateTime } from '@/lib/time';
import { MediaViewer } from '../../inbox/composerExtras';
import { MenuSelect } from '../../MenuSelect';

// Contact details page "Media": every file in this customer's chat, received or sent. Filter by type, sort, select;
// click to view or play (documents download); Download saves the selected files.
const TYPE_ICONS: Record<string, React.ReactNode> = {
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </>
  ),
  video: (
    <>
      <rect x="2" y="6" width="14" height="12" rx="2" />
      <path d="m22 8-6 4 6 4z" />
    </>
  ),
  audio: (
    <>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </>
  ),
  document: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </>
  ),
  sticker: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" />
    </>
  ),
};
const iconFor = (type: string) => TYPE_ICONS[type === 'voice' ? 'audio' : type] ?? TYPE_ICONS.document;

// Small picture preview for photos and stickers (loaded with the sign-in token); the type icon otherwise
function Thumb({ file }: { file: ChatFile }) {
  const [src, setSrc] = useState<string | null>(null);
  const isPicture = (file.type === 'image' || file.type === 'sticker') && file.available;
  useEffect(() => {
    if (!isPicture) return;
    let cancelled = false;
    mediaUrl(file.id)
      .then((u) => !cancelled && setSrc(u))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [file.id, isPicture]);
  if (src) return <img src={src} alt="" className="h-11 w-11 shrink-0 rounded-lg object-cover" />;
  return (
    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-surface-strong text-body-soft">
      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {iconFor(file.type)}
      </svg>
    </span>
  );
}

// A name to save a file under: its own (documents), else e.g. "photo-2026-10-16.jpg"
function saveName(f: ChatFile) {
  if (f.mediaName) return f.mediaName;
  const ext = (f.mediaMime?.split('/')[1] ?? 'bin').replace('jpeg', 'jpg').replace('mpeg', 'mp3').replace('quicktime', 'mov');
  return `${fileLabel(f.type).toLowerCase().replace(/\s+/g, '-')}-${f.createdAt.slice(0, 10)}.${ext}`;
}

export function MediaTab({ conversationId, initialType = 'all' }: { conversationId: string | null; initialType?: string }) {
  const [files, setFiles] = useState<ChatFile[] | null>(null);
  const [error, setError] = useState('');
  const [type, setType] = useState(() => (MEDIA_FILTERS.some((f) => f.value === initialType) ? initialType : 'all'));
  const [sort, setSort] = useState('latest');
  const [selected, setSelected] = useState<string[]>([]);
  const [viewing, setViewing] = useState<ChatFile | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSelected([]);
    if (!conversationId) {
      setFiles([]);
      return;
    }
    setFiles(null);
    fetchChatFiles(conversationId)
      .then((f) => !cancelled && setFiles(f))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const shown = filterSortFiles(files ?? [], type, sort);
  const allSelected = shown.length > 0 && shown.every((f) => selected.includes(f.id));
  const selectedFiles = (files ?? []).filter((f) => selected.includes(f.id) && f.available);
  async function downloadSelected() {
    setDownloading(true);
    setError('');
    try {
      for (const f of selectedFiles) await downloadFile(f.id, saveName(f));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDownloading(false);
    }
  }
  const open = (f: ChatFile) => (f.type === 'document' ? downloadFile(f.id, saveName(f)).catch((e) => setError((e as Error).message)) : setViewing(f));
  const toggleAll = () => setSelected(allSelected ? selected.filter((id) => !shown.some((f) => f.id === id)) : [...new Set([...selected, ...shown.map((f) => f.id)])]);

  return (
    <section aria-label="Media" className="mt-5">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <span className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Filter by</span>
          <MenuSelect value={type} options={MEDIA_FILTERS} onChange={setType} label="Filter media by type" />
        </span>
        <span className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Sort by</span>
          <MenuSelect value={sort} options={MEDIA_SORTS} onChange={setSort} label="Sort media" />
        </span>
        <span className="ml-auto flex items-center gap-3">
          {selected.length > 0 && <span className="text-xs text-muted">{selected.length} selected</span>}
          <button
            type="button"
            disabled={!selectedFiles.length || downloading}
            onClick={downloadSelected}
            title={selectedFiles.length ? `Download ${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'}` : 'Select files to download'}
            className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] text-primary transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:text-faint disabled:hover:bg-transparent"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
            {downloading ? 'Downloading…' : 'Download'}
          </button>
        </span>
      </div>

      <label className="mt-5 flex w-fit cursor-pointer items-center gap-3 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <input type="checkbox" checked={allSelected} disabled={!shown.length} onChange={toggleAll} aria-label="Select all visible" className="h-4 w-4 cursor-pointer rounded border-line-strong accent-primary disabled:cursor-default" />
        Select all visible
      </label>

      {error ? (
        <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>
      ) : files === null ? (
        <p className="mt-6 text-xs text-faint">Loading…</p>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-10 text-center">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-strong text-body-soft">
            <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
              <path d="M14 3v5h5" />
              <circle cx="11.5" cy="14.5" r="2.5" />
              <path d="m13.5 16.5 2 2" />
            </svg>
          </span>
          <p className="mt-2.5 text-[13px] font-bold text-ink">No media files here</p>
          <p className="mt-1 text-xs text-muted">
            {type === 'all' ? 'Media files shared by this contact, such as images or videos, will appear here.' : 'No files of this type. Try another filter.'}
          </p>
        </div>
      ) : (
        <>
          <ul className="mt-3 space-y-2">
            {shown.map((f) => {
              const on = selected.includes(f.id);
              return (
                <li key={f.id} className={`flex items-center gap-4 rounded-lg bg-surface px-4 py-2.5 shadow-[0_1px_3px_rgba(16,24,40,0.08)] ${on ? 'ring-1 ring-primary' : ''}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => setSelected((s) => (on ? s.filter((x) => x !== f.id) : [...s, f.id]))}
                    aria-label={`Select ${fileLabel(f.type)} from ${formatDateTime(f.createdAt)}`}
                    className="h-4 w-4 shrink-0 cursor-pointer rounded border-line-strong accent-primary"
                  />
                  <button
                    type="button"
                    disabled={!f.available}
                    onClick={() => open(f)}
                    title={f.available ? (f.type === 'document' ? `Download ${saveName(f)}` : `Open ${fileLabel(f.type).toLowerCase()}`) : 'Not available'}
                    className="flex min-w-0 flex-1 items-center gap-4 text-left disabled:cursor-default"
                  >
                    <Thumb file={f} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-ink">{f.mediaName || fileLabel(f.type)}</span>
                      <span className="block text-[11px] text-muted">
                        {f.direction === 'in' ? 'From the customer' : 'From your team'}
                        {f.mediaSize ? ` · ${formatSize(f.mediaSize)}` : ''}
                        {!f.available && ' · not available'}
                      </span>
                    </span>
                    <span className="shrink-0 text-[11px] text-faint">{formatDateTime(f.createdAt)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {shown.some((f) => !f.available) && (
            <p className="mt-3 text-[11px] text-faint">Files marked “not available” arrived before the app started saving files, so there is no copy to open.</p>
          )}
        </>
      )}
      {viewing && <MediaViewer file={viewing} onClose={() => setViewing(null)} />}
    </section>
  );
}
