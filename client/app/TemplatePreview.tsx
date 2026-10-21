'use client';

import { useEffect, useState } from 'react';
import { type Piece, fillPieces } from '@/lib/templates';

// What the customer sees on WhatsApp: the template as a message bubble (header, body, footer) with its buttons
// under it. Values not filled in yet show as highlighted {{n}}. Used by the chat's "Send template" and by the
// template editor (Settings → Templates).
export type PreviewButton = { type: string; text: string };

export function TemplatePreview({
  headerFormat,
  headerText,
  headerValues = {},
  headerFile,
  body,
  bodyValues = {},
  footer,
  buttons = [],
  businessName,
}: {
  headerFormat?: string | null;
  headerText?: string;
  headerValues?: Record<string, string>;
  headerFile?: File | null;
  body: string;
  bodyValues?: Record<string, string>;
  footer?: string | null;
  buttons?: PreviewButton[];
  businessName?: string;
}) {
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!headerFile || !/^(image|video)\//.test(headerFile.type)) return setFileUrl(null);
    const url = URL.createObjectURL(headerFile);
    setFileUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [headerFile]);

  const pieces = (list: Piece[]) =>
    list.map((p, i) =>
      p.variable ? (
        <span key={i} className={p.filled ? 'font-medium' : 'rounded bg-[#fff1b8] px-0.5 text-[#8a6100]'}>
          {p.text}
        </span>
      ) : (
        <span key={i}>{p.text}</span>
      ),
    );
  const media = headerFormat === 'IMAGE' || headerFormat === 'VIDEO' || headerFormat === 'DOCUMENT';

  return (
    <div className="rounded-2xl bg-[#efeae2] p-4" aria-label="Template preview">
      {businessName && <p className="mb-2 text-center text-[10px] font-medium uppercase tracking-wide text-[#54656f]">{businessName}</p>}
      <div className="max-w-[300px]">
        <div className="overflow-hidden rounded-xl rounded-tl-sm bg-[#fff] shadow-sm">
          {media && (
            <div className="p-1">
              {fileUrl && headerFormat === 'IMAGE' ? (
                <img src={fileUrl} alt="Header" className="max-h-44 w-full rounded-lg object-cover" />
              ) : fileUrl && headerFormat === 'VIDEO' ? (
                <video src={fileUrl} className="max-h-44 w-full rounded-lg bg-[#000]" muted />
              ) : (
                <div className="flex h-28 flex-col items-center justify-center gap-1 rounded-lg bg-[#e9edef] text-[#54656f]">
                  <span className="text-2xl" aria-hidden="true">
                    {headerFormat === 'IMAGE' ? '🖼️' : headerFormat === 'VIDEO' ? '🎬' : '📄'}
                  </span>
                  <span className="max-w-full truncate px-3 text-[11px]">{headerFile ? headerFile.name : `${headerFormat!.charAt(0)}${headerFormat!.slice(1).toLowerCase()} header`}</span>
                </div>
              )}
            </div>
          )}
          <div className="px-3 pb-1.5 pt-2 text-[13px] leading-relaxed text-[#111b21]">
            {headerFormat === 'TEXT' && headerText && <p className="mb-1 font-bold">{pieces(fillPieces(headerText, headerValues))}</p>}
            <p className="whitespace-pre-wrap break-words">{body ? pieces(fillPieces(body, bodyValues)) : <span className="text-[#8696a0]">Message body</span>}</p>
            {footer && <p className="mt-1 text-[11px] text-[#8696a0]">{footer}</p>}
            <p className="mt-0.5 text-right text-[10px] text-[#8696a0]">12:00</p>
          </div>
        </div>
        {buttons.length > 0 && (
          <div className="mt-1 space-y-1">
            {buttons.slice(0, 10).map((b, i) => (
              <div key={i} className="flex items-center justify-center gap-1.5 rounded-xl bg-[#fff] py-2 text-[13px] font-medium text-[#027eb5] shadow-sm">
                <span aria-hidden="true">{b.type === 'URL' ? '↗' : b.type === 'PHONE_NUMBER' ? '📞' : b.type === 'COPY_CODE' || b.type === 'OTP' ? '⧉' : '↩'}</span>
                {b.text || (b.type === 'COPY_CODE' ? 'Copy offer code' : 'Button')}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
