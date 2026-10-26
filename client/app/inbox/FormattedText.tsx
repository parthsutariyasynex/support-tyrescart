'use client';

import { Fragment, type ReactNode, useMemo } from 'react';
import { type Block, type Inline, parseFormatting } from '@/lib/formatting';
import { linkSegments } from '@/lib/links';
import { highlightSegments } from '@/lib/messageSearch';
import { mentionPieces } from '@/lib/mentions';

// A message's (or note's) text with WhatsApp formatting shown: bold, italic, strikethrough, monospace, inline code,
// lists and quotes (lib/formatting.ts). Web addresses stay links that open in a new tab, "Search in conversation"
// matches stay marked, and in notes @mentions stay highlighted. The text itself is rendered as React text (never as
// HTML), so nothing a customer writes can inject markup.
type Options = { highlightTerm: string; mentionNames?: string[] };

function Highlighted({ text, term }: { text: string; term: string }) {
  if (!term) return <>{text}</>;
  return (
    <>
      {highlightSegments(text, term).map((seg, i) =>
        seg.match ? (
          <mark key={i} className="rounded-sm bg-warning-soft px-0.5 text-ink">
            {seg.text}
          </mark>
        ) : (
          <Fragment key={i}>{seg.text}</Fragment>
        ),
      )}
    </>
  );
}

// Plain text: links (messages) or @mentions (notes), with search matches marked
function Plain({ text, opts }: { text: string; opts: Options }) {
  if (opts.mentionNames)
    return (
      <>
        {mentionPieces(text, opts.mentionNames).map((p, i) =>
          p.mention ? (
            <span key={i} className="font-semibold text-primary">
              {p.text}
            </span>
          ) : (
            <Highlighted key={i} text={p.text} term={opts.highlightTerm} />
          ),
        )}
      </>
    );
  return (
    <>
      {linkSegments(text).map((part, p) =>
        part.href ? (
          <a
            key={p}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer"
            title={part.href}
            onClick={(e) => e.stopPropagation()}
            className="break-all text-link underline decoration-1 underline-offset-2 hover:opacity-80"
          >
            <Highlighted text={part.text} term={opts.highlightTerm} />
          </a>
        ) : (
          <Highlighted key={p} text={part.text} term={opts.highlightTerm} />
        ),
      )}
    </>
  );
}

function Inlines({ nodes, opts }: { nodes: Inline[]; opts: Options }): ReactNode {
  return nodes.map((n, i) => {
    switch (n.kind) {
      case 'text':
        return <Plain key={i} text={n.text} opts={opts} />;
      case 'bold':
        return (
          <strong key={i} className="font-bold">
            <Inlines nodes={n.children} opts={opts} />
          </strong>
        );
      case 'italic':
        return (
          <em key={i} className="italic">
            <Inlines nodes={n.children} opts={opts} />
          </em>
        );
      case 'strike':
        return (
          <s key={i} className="line-through">
            <Inlines nodes={n.children} opts={opts} />
          </s>
        );
      case 'code':
        return (
          <code key={i} className="rounded bg-ink/[0.08] px-1 py-px font-mono text-[12px]">
            <Highlighted text={n.text} term={opts.highlightTerm} />
          </code>
        );
      case 'mono':
        return (
          <code key={i} className={`font-mono text-[12px] ${n.text.includes('\n') ? 'my-0.5 block' : ''}`}>
            <Highlighted text={n.text} term={opts.highlightTerm} />
          </code>
        );
    }
  });
}

// Each line on its own row (an empty line keeps its height), so blank lines and leading spaces show as typed
function Lines({ lines, opts }: { lines: Inline[][]; opts: Options }) {
  return (
    <>
      {lines.map((line, i) => (
        <div key={i}>{line.length ? <Inlines nodes={line} opts={opts} /> : <br />}</div>
      ))}
    </>
  );
}

function BlockView({ block, opts }: { block: Block; opts: Options }) {
  switch (block.kind) {
    case 'paragraph':
      return <Lines lines={block.lines} opts={opts} />;
    case 'bullet':
      return (
        <ul className="list-disc pl-5 marker:text-current">
          {block.items.map((item, i) => (
            <li key={i}>
              <Inlines nodes={item} opts={opts} />
            </li>
          ))}
        </ul>
      );
    case 'numbered':
      return (
        <ol className="list-decimal pl-6">
          {block.items.map((item, i) => (
            <li key={i} value={item.number}>
              <Inlines nodes={item.content} opts={opts} />
            </li>
          ))}
        </ol>
      );
    case 'quote':
      return (
        <blockquote className="my-0.5 border-l-[3px] border-current/30 pl-2 opacity-80">
          <Lines lines={block.lines} opts={opts} />
        </blockquote>
      );
  }
}

export function FormattedText({
  text,
  highlightTerm = '',
  mentionNames,
  className = '',
}: {
  text: string;
  highlightTerm?: string;
  // Notes: teammates' names, highlighted as @mentions (notes show no links, as before)
  mentionNames?: string[];
  className?: string;
}) {
  const blocks = useMemo(() => parseFormatting(text), [text]);
  const opts = { highlightTerm, mentionNames };
  return (
    <div className={`whitespace-pre-wrap break-words ${className}`}>
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} opts={opts} />
      ))}
    </div>
  );
}
