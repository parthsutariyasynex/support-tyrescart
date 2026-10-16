'use client';

import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { updateMyProfile } from '@/lib/auth';
import { showToast } from '@/lib/toasts';
import { AppShell, type Me } from '../../AppShell';
import { inputClass } from '../../AuthShell';
import { SettingsShell } from '../SettingsShell';

// Settings → Your preferences → WhatsApp QR code: the workspace's connected WhatsApp number as a wa.me link and a QR
// code (with the WhatsApp logo) customers scan to start a chat. Your own "first message" (saved on your profile,
// so each teammate has theirs) is filled in for the customer. Copy the link, download the QR code, preview what the
// customer sees, and ways to share it.
export default function WhatsAppQrPage() {
  return (
    <AppShell>
      {(me) => (
        <SettingsShell me={me} section="Your preferences" title="WhatsApp QR code">
          <Qr me={me} />
        </SettingsShell>
      )}
    </AppShell>
  );
}

function waLink(displayPhone: string, text: string) {
  const digits = displayPhone.replace(/\D/g, '');
  return `https://wa.me/${digits}${text.trim() ? `?text=${encodeURIComponent(text.trim())}` : ''}`;
}

// The WhatsApp mark (white handset in a speech bubble) for the middle of the QR code
const WA_PATH =
  'M16.04 3C9.06 3 3.4 8.66 3.4 15.64c0 2.23.58 4.4 1.69 6.32L3.3 28.7l6.93-1.82a12.6 12.6 0 0 0 5.81 1.42h.01c6.98 0 12.64-5.66 12.64-12.64S23.02 3 16.04 3Zm0 23.1h-.01a10.5 10.5 0 0 1-5.35-1.47l-.38-.23-4.11 1.08 1.1-4.01-.25-.41a10.46 10.46 0 0 1-1.6-5.42c0-5.8 4.72-10.52 10.53-10.52 2.81 0 5.45 1.1 7.44 3.08a10.46 10.46 0 0 1 3.08 7.45c0 5.8-4.72 10.45-10.45 10.45Zm5.77-7.87c-.32-.16-1.87-.92-2.16-1.03-.29-.1-.5-.16-.71.16-.21.32-.81 1.03-1 1.24-.18.21-.37.24-.69.08-.32-.16-1.34-.49-2.55-1.57-.94-.84-1.58-1.88-1.76-2.2-.18-.32-.02-.49.14-.65.14-.14.32-.37.48-.55.16-.18.21-.32.32-.53.1-.21.05-.4-.03-.55-.08-.16-.71-1.71-.97-2.34-.26-.62-.52-.53-.71-.54h-.61c-.21 0-.55.08-.84.4-.29.32-1.1 1.08-1.1 2.63s1.13 3.05 1.29 3.26c.16.21 2.22 3.39 5.38 4.75.75.32 1.34.52 1.8.66.76.24 1.44.21 1.99.13.61-.09 1.87-.76 2.13-1.5.26-.74.26-1.37.18-1.5-.08-.13-.29-.21-.61-.37Z';

// A PNG of the QR code (high error correction, so the logo in the middle doesn't stop it scanning)
async function qrPng(link: string, size = 640) {
  const canvas = document.createElement('canvas');
  await QRCode.toCanvas(canvas, link, { width: size, margin: 2, errorCorrectionLevel: 'H' });
  const ctx = canvas.getContext('2d')!;
  const r = size * 0.11;
  const c = size / 2;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(c, c, r + size * 0.02, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#25d366';
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  const scale = (r * 1.25) / 32;
  ctx.translate(c - 16 * scale, c - 16 * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff';
  ctx.fill(new Path2D(WA_PATH));
  ctx.restore();
  return canvas.toDataURL('image/png');
}

const Icon = ({ d, className = 'h-4 w-4' }: { d: string; className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const COPY = 'M8 8h11v11H8zM5 16V5h11';
const DOWNLOAD = 'M12 4v11M7 10l5 5 5-5M5 20h14';

function Qr({ me }: { me: Me }) {
  const phone = me.workspace.whatsapp?.displayPhone ?? null;
  const saved = me.user.qrMessage ?? '';
  const [text, setText] = useState(saved);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [png, setPng] = useState('');
  const [preview, setPreview] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setText(saved), [saved]);
  const link = phone ? waLink(phone, saved) : '';
  useEffect(() => {
    if (!link) return;
    qrPng(link)
      .then(setPng)
      .catch(() => setPng(''));
  }, [link]);

  if (!phone)
    return (
      <div className="max-w-xl rounded-2xl border border-line bg-surface p-8 text-center">
        <p className="text-sm font-semibold text-ink">No WhatsApp number connected</p>
        <p className="mt-1 text-xs text-muted">Once your business number is connected, its link and QR code appear here for customers to scan.</p>
      </div>
    );

  const copy = (value: string, what: string) =>
    navigator.clipboard
      .writeText(value)
      .then(() => showToast(`qr:${Date.now()}`, '', `${what} copied.`, 'WhatsApp QR code'))
      .catch(() => showToast(`qr:${Date.now()}`, '', `Couldn't copy the ${what.toLowerCase()}.`, 'WhatsApp QR code'));
  const fileName = `whatsapp-qr-${phone.replace(/\D/g, '')}.png`;
  const download = () => {
    if (!png) return;
    const a = document.createElement('a');
    a.href = png;
    a.download = fileName;
    a.click();
  };
  const html = `<a href="${link}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:8px;padding:10px 18px;border-radius:999px;background:#25d366;color:#fff;font:600 15px/1 sans-serif;text-decoration:none">Chat with us on WhatsApp</a>`;

  async function saveMessage() {
    setBusy(true);
    try {
      await updateMyProfile({ qrMessage: text.trim() });
      setEditing(false);
      showToast(`qr:${Date.now()}`, '', text.trim() ? 'First message saved.' : 'First message cleared.', 'WhatsApp QR code');
    } catch (e) {
      showToast(`qr:${Date.now()}`, '', (e as Error).message, 'WhatsApp QR code');
    } finally {
      setBusy(false);
    }
  }

  const card = 'rounded-xl border border-line bg-surface p-5';
  const share = [
    { title: 'Social media bio', text: 'Add your link to your Instagram, Facebook, or LinkedIn profile.', icon: 'M18 8a3 3 0 1 0-2.8-4M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm12 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8.6 13.5l6.8 4M15.4 6.5l-6.8 4', action: 'Copy link', onClick: () => copy(link, 'Link') },
    { title: 'Add to your website', text: 'Add a WhatsApp chat button so website visitors can message you directly.', icon: 'M3 5h18v12H3zM8 21h8M12 17v4', action: 'Copy HTML code', onClick: () => copy(html, 'HTML code') },
    { title: 'Print materials', text: 'Add your QR code to business cards, receipts, packaging, or signage.', icon: 'M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h6', action: 'Download QR code', onClick: download },
  ];

  return (
    <div className="max-w-5xl">
      <section className={`${card} !p-6`}>
        <div className="inline-flex items-center gap-3 rounded-xl border border-line px-4 py-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-success-soft text-success">
            <svg className="h-6 w-6" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
              <path d={WA_PATH} />
            </svg>
          </span>
          <div>
            <p className="flex items-center gap-2 text-[15px] font-bold text-ink">
              {phone}
              <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-success">
                <span className="h-1.5 w-1.5 rounded-full bg-success" /> Connected
              </span>
            </p>
            <p className="text-[12px] text-muted">{me.workspace.name}</p>
          </div>
        </div>
        <div className="mt-6 grid items-start gap-8 border-t border-line pt-6 md:grid-cols-[1fr_auto]">
          <div className="max-w-lg">
            <p className="mb-1.5 text-[13px] font-semibold text-ink">Your WhatsApp link</p>
            <input readOnly value={link} aria-label="Your WhatsApp link" onFocus={(e) => e.currentTarget.select()} className={`${inputClass} font-mono !text-[12px]`} />
            <button
              type="button"
              onClick={() => copy(link, 'Link')}
              className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-[14px] font-semibold text-on-primary transition hover:bg-primary-hover"
            >
              <Icon d={COPY} /> Copy link
            </button>
            <p className="mb-1.5 mt-6 flex items-center gap-1 text-[13px] font-semibold text-ink">
              Customer&apos;s first message
              <span title="Filled in for the customer when they open the chat from your link or QR code; they can change it before sending. Saved for you only." className="cursor-help text-faint">
                <Icon d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 16v-4M12 8h.01" className="h-3.5 w-3.5" />
              </span>
            </p>
            {editing ? (
              <div className="flex gap-2">
                <input
                  ref={inputRef}
                  autoFocus
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveMessage();
                    if (e.key === 'Escape') {
                      setText(saved);
                      setEditing(false);
                    }
                  }}
                  maxLength={300}
                  placeholder="e.g. Hi! I'd like to know more about tyres for my car"
                  aria-label="Customer's first message"
                  className={inputClass}
                />
                <button type="button" disabled={busy} onClick={saveMessage} className="shrink-0 rounded-lg bg-primary px-4 text-[13px] font-semibold text-on-primary disabled:opacity-50">
                  {busy ? 'Saving…' : 'Save'}
                </button>
                <button type="button" disabled={busy} onClick={() => (setText(saved), setEditing(false))} className="shrink-0 rounded-lg px-3 text-[13px] text-body-soft hover:bg-surface-muted">
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-lg bg-surface-strong px-3.5 py-2.5">
                <p className={`min-w-0 flex-1 truncate text-[13px] ${saved ? 'text-body' : 'text-faint'}`}>{saved || 'No first message'}</p>
                <button type="button" onClick={() => setEditing(true)} className="flex shrink-0 items-center gap-1 text-[13px] font-semibold text-primary hover:underline">
                  <Icon d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" className="h-3.5 w-3.5" /> Edit
                </button>
              </div>
            )}
          </div>
          <div className="flex flex-col items-center gap-3">
            <div className="rounded-2xl border border-line bg-surface-muted p-3">
              {png ? <img src={png} alt={`QR code to chat with ${phone} on WhatsApp`} className="h-48 w-48 rounded-lg bg-[#fff]" /> : <div className="h-48 w-48 animate-pulse rounded-lg bg-surface-strong" />}
            </div>
            <button type="button" disabled={!png} onClick={download} className="flex items-center gap-2 rounded-lg border border-primary px-4 py-1.5 text-[13px] font-medium text-primary transition hover:bg-primary/5 disabled:opacity-50">
              <Icon d={DOWNLOAD} /> Download QR code
            </button>
          </div>
        </div>
      </section>

      <button type="button" onClick={() => setPreview(true)} className="mt-6 flex items-center gap-2 text-[14px] font-semibold text-primary hover:underline">
        <Icon d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /> Preview customer experience
      </button>

      <p className="mb-3 mt-6 text-[11px] font-semibold uppercase tracking-wide text-muted">Share your WhatsApp link with customers</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {share.map((s) => (
          <div key={s.title} className={`${card} flex gap-3`}>
            <span className="mt-0.5 text-body-soft">
              <Icon d={s.icon} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <p className="text-[14px] font-semibold text-ink">{s.title}</p>
              <p className="mt-1 flex-1 text-[12px] leading-relaxed text-body-soft">{s.text}</p>
              <button type="button" onClick={s.onClick} className="mt-3 flex items-center gap-1.5 self-start text-[13px] font-semibold text-primary hover:underline">
                <Icon d={s.action === 'Download QR code' ? DOWNLOAD : COPY} className="h-3.5 w-3.5" /> {s.action}
              </button>
            </div>
          </div>
        ))}
      </div>

      {preview && <Preview phone={phone} name={me.workspace.name} message={saved} onClose={() => setPreview(false)} />}
    </div>
  );
}

// What a customer sees after scanning: WhatsApp opens a chat with the business, the first message ready to send
function Preview({ phone, name, message, onClose }: { phone: string; name: string; message: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Customer experience preview" className="w-full max-w-sm rounded-2xl bg-surface p-5 shadow-2xl">
        <div className="flex items-center justify-between">
          <p className="text-[15px] font-bold text-ink">What your customer sees</p>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-lg text-body-soft hover:bg-surface-muted">
            <Icon d="M18 6 6 18M6 6l12 12" className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-4 overflow-hidden rounded-[28px] border-[6px] border-ink/80 bg-[#efeae2]">
          <div className="flex items-center gap-2.5 bg-[#075e54] px-3 py-2.5 text-on-primary">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-on-primary/20 text-[13px] font-bold">{name.charAt(0).toUpperCase()}</span>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold">{name}</p>
              <p className="text-[10px] opacity-80">{phone}</p>
            </div>
          </div>
          <div className="flex h-72 flex-col justify-end gap-2 p-3">
            <p className="mx-auto rounded-md bg-[#fff5c4] px-2.5 py-1 text-center text-[10px] text-[#54656f]">Chat opened from your link or QR code</p>
          </div>
          <div className="flex items-center gap-2 bg-[#f0f2f5] px-2 py-2">
            <p className={`min-h-9 flex-1 rounded-full bg-[#fff] px-3.5 py-2 text-[13px] ${message ? 'text-[#111b21]' : 'text-[#8696a0]'}`}>{message || 'Message'}</p>
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#00a884] text-[#fff]">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M3 20.5 21 12 3 3.5l.02 6.6L15 12 3.02 13.9z" />
              </svg>
            </span>
          </div>
        </div>
        <p className="mt-3 text-[12px] text-muted">{message ? 'The message is filled in; the customer taps send to start the chat.' : 'No first message: the customer types their own.'}</p>
      </div>
    </div>
  );
}
