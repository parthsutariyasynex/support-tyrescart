'use client';

import type { ReactNode } from 'react';
import type { InlineStyle, LineStyle } from '@/lib/formatting';

// WhatsApp formatting for the message box: shown with the "Aa" button, or on its own while text is selected.
// Each button wraps the selection (or the lines it touches) in WhatsApp's markers, or takes them off again.
// Buttons don't take the focus, so the selection stays and typing carries on.
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

const INLINE: { style: InlineStyle; label: string; title: string; content: ReactNode }[] = [
  { style: 'bold', label: 'Bold', title: `Bold  *text*  (${MOD}B)`, content: <span className="font-bold">B</span> },
  { style: 'italic', label: 'Italic', title: `Italic  _text_  (${MOD}I)`, content: <span className="font-serif italic">I</span> },
  { style: 'strike', label: 'Strikethrough', title: `Strikethrough  ~text~  (${MOD}Shift+X)`, content: <span className="line-through">S</span> },
  { style: 'mono', label: 'Monospace', title: `Monospace  \`\`\`text\`\`\`  (${MOD}Shift+M)`, content: <span className="font-mono text-[11px]">{'</>'}</span> },
  { style: 'code', label: 'Inline code', title: 'Inline code  `text`', content: <span className="font-mono text-[11px]">{'`c`'}</span> },
];

const icon = (d: ReactNode) => (
  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);

const LINES: { style: LineStyle; label: string; title: string; content: ReactNode }[] = [
  {
    style: 'bullet',
    label: 'Bulleted list',
    title: 'Bulleted list  - text',
    content: icon(
      <>
        <path d="M9 6h11M9 12h11M9 18h11" />
        <circle cx="4.5" cy="6" r="1" fill="currentColor" />
        <circle cx="4.5" cy="12" r="1" fill="currentColor" />
        <circle cx="4.5" cy="18" r="1" fill="currentColor" />
      </>,
    ),
  },
  {
    style: 'numbered',
    label: 'Numbered list',
    title: 'Numbered list  1. text',
    content: icon(
      <>
        <path d="M10 6h10M10 12h10M10 18h10" />
        <path d="M4 5h1v4M4 9h2M4 14.5c0-.8.7-1.5 1.5-1.5s1.2.6 1.2 1.2c0 1.3-2.7 1.8-2.7 3.8h2.7" strokeWidth="1.5" />
      </>,
    ),
  },
  {
    style: 'quote',
    label: 'Quote',
    title: 'Quote  > text',
    content: icon(
      <>
        <path d="M4 5v14" strokeWidth="3" />
        <path d="M9 8h11M9 12h11M9 16h7" />
      </>,
    ),
  },
];

function ToolButton({ label, title, onApply, children }: { label: string; title: string; onApply: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      // mousedown, not click: the message box keeps its focus and selection
      onMouseDown={(e) => {
        e.preventDefault();
        onApply();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onApply();
        }
      }}
      className="flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-[13px] text-body-soft transition hover:bg-surface-strong hover:text-ink"
    >
      {children}
    </button>
  );
}

export function FormatToolbar({ onInline, onLines }: { onInline: (style: InlineStyle) => void; onLines: (style: LineStyle) => void }) {
  return (
    <div role="toolbar" aria-label="Text formatting" className="mb-1.5 flex w-fit max-w-full flex-wrap items-center gap-0.5 rounded-lg border border-line bg-surface px-1 py-0.5 shadow-2xs">
      {INLINE.map((b) => (
        <ToolButton key={b.style} label={b.label} title={b.title} onApply={() => onInline(b.style)}>
          {b.content}
        </ToolButton>
      ))}
      <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
      {LINES.map((b) => (
        <ToolButton key={b.style} label={b.label} title={b.title} onApply={() => onLines(b.style)}>
          {b.content}
        </ToolButton>
      ))}
    </div>
  );
}
