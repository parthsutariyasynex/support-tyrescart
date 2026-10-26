'use client';

import { type CSSProperties, forwardRef, useMemo } from 'react';
import { BOLD, CODE, ITALIC, MARKER, STRIKE, styledRuns } from '@/lib/formatting';

// WhatsApp-style formatting while typing: the message box's text is drawn here, right under the (see-through)
// box, with *bold*, _italic_, ~strikethrough~ and `code` already shown and their markers faded, like WhatsApp.
// The box itself stays a plain text box (typing, the cursor, undo, mentions and quick replies work as before), so
// every character here must take exactly the space it takes there: bold is drawn with a thin shadow (real bold
// is wider), italic words are the upright letters slanted (the system font's real italic is narrower or wider),
// code gets a background instead of a monospace font.
const BOLD_STYLE: CSSProperties = { textShadow: '0.35px 0 0 currentColor, -0.35px 0 0 currentColor' };
const SLANT: CSSProperties = { display: 'inline-block', transform: 'skewX(-10deg)' };
// A slanted word can't break across lines (the box can break a very long word), so longer ones stay upright
const SLANT_MAX = 30;

// Italic: each word slanted on its own; spaces and line breaks stay plain text, so lines wrap as in the box
function Slanted({ text, strike }: { text: string; strike: boolean }) {
  return (
    <>
      {text.split(/(\s+)/).map((part, i) =>
        part && !/\s/.test(part) && part.length <= SLANT_MAX ? (
          // A line-through doesn't reach inside the word's own box, so it gets its own
          <span key={i} style={SLANT} className={strike ? 'line-through' : undefined}>
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

function classOf(style: number) {
  return [
    style & STRIKE ? 'line-through' : '',
    style & CODE ? 'rounded-sm bg-ink/10' : '',
    style & MARKER ? 'opacity-40' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export const ComposerHighlight = forwardRef<HTMLDivElement, { text: string; className?: string }>(function ComposerHighlight({ text, className = '' }, ref) {
  const runs = useMemo(() => styledRuns(text), [text]);
  return (
    <div ref={ref} aria-hidden="true" className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap [overflow-wrap:break-word] ${className}`}>
      {runs.map((r, i) =>
        r.style ? (
          <span key={i} className={classOf(r.style)} style={r.style & BOLD ? BOLD_STYLE : undefined}>
            {r.style & ITALIC ? <Slanted text={r.text} strike={!!(r.style & STRIKE)} /> : r.text}
          </span>
        ) : (
          r.text
        ),
      )}
      {/* A last empty line still takes its height, as in the box */}
      {'​'}
    </div>
  );
});
