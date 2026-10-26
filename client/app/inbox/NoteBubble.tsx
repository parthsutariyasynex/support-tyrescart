'use client';

import { useEffect, useState } from 'react';
import { type ContactRemark, type RemarkFile, downloadRemarkFile, remarkFileUrl } from '@/lib/contacts';
import { documentLabel, formatSize } from '@/lib/media';
import { formatTime } from '@/lib/time';
import { FormattedText } from './FormattedText';

// An internal note in the chat (SleekFlow style): a yellow bubble on the team's side, marked "Internal note" with
// who wrote it, @mentions highlighted, WhatsApp formatting shown. Only the team ever sees it; notes are never sent to WhatsApp or the customer
// (they are the customer's remarks: edited or deleted in the profile panel, Remarks).
export function NoteBubble({ note, teammateNames }: { note: ContactRemark; teammateNames: string[] }) {
  return (
    <div className="flex justify-end" role="note" aria-label={`Internal note${note.authorName ? ` by ${note.authorName}` : ''}`}>
      <div className="max-w-[75%]">
        <div className="rounded-xl rounded-tr-sm border border-dashed border-warning-border bg-warning-soft px-3 py-2 text-[13px] leading-relaxed text-ink shadow-2xs">
          {/* WhatsApp formatting shown as in messages; @mentions highlighted */}
          {note.body && <FormattedText text={note.body} mentionNames={teammateNames} />}
          <NoteFiles files={note.files} className={note.body ? 'mt-2' : ''} />
          <p className="mt-0.5 text-right text-[10px] text-faint">
            {note.editedAt && 'edited · '}
            {formatTime(note.createdAt)}
          </p>
        </div>
        <p className="mt-1 flex items-center justify-end gap-1 text-[10px] text-muted">
          <svg className="h-3 w-3 text-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M12 17H8" />
          </svg>
          <span className="font-semibold text-warning">Internal note</span>
          {note.authorName && <span>· {note.authorName}</span>}
          <span>· only your team sees this</span>
        </p>
      </div>
    </div>
  );
}

// The images and documents on a note: images as thumbnails, documents as a name and size; a click downloads it. Used
// in the chat bubble and in the profile's Remarks.
export function NoteFiles({ files, className = '' }: { files: RemarkFile[]; className?: string }) {
  if (!files?.length) return null;
  return (
    <ul className={`flex flex-wrap gap-1.5 ${className}`} aria-label="Attached files">
      {files.map((f) => (
        <li key={f.id}>
          <button
            type="button"
            onClick={() => void downloadRemarkFile(f).catch(() => {})}
            title={`Download ${f.name}`}
            className="flex max-w-[240px] items-center gap-2 rounded-lg border border-warning-border bg-surface px-2 py-1.5 text-left hover:bg-surface-muted"
          >
            {f.mime.startsWith('image/') ? <NoteThumb file={f} /> : <span className="shrink-0 rounded bg-surface-strong px-1.5 py-1 text-[9px] font-bold text-body-soft">{documentLabel(f.mime, f.name)}</span>}
            <span className="min-w-0">
              <span className="block truncate text-[12px] font-medium text-ink">{f.name}</span>
              <span className="block text-[10px] text-faint">{formatSize(f.size)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function NoteThumb({ file }: { file: RemarkFile }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    remarkFileUrl(file.id).then((u) => live && setSrc(u), () => {});
    return () => {
      live = false;
    };
  }, [file.id]);
  return src ? <img src={src} alt="" className="h-9 w-9 shrink-0 rounded object-cover" /> : <span className="h-9 w-9 shrink-0 animate-pulse rounded bg-surface-strong" />;
}
