'use client';

import { useEffect, useRef, useState } from 'react';
import { type QuickReply, fetchQuickReplies, highlightParts, matchesQuickReply } from '@/lib/quickReplies';

// Results for the "/" menu, fetched from the API as the search changes (only the latest request may update)
export function useQuickReplies(search: string | null) {
  // The results and the search they were fetched for
  const [result, setResult] = useState<{ search: string; items: QuickReply[] }>({ search: '', items: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);
  useEffect(() => {
    if (search === null) return;
    const n = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      fetchQuickReplies(search)
        .then((list) => {
          if (n !== seq.current) return;
          setResult({ search, items: list });
          setError('');
        })
        .catch((err) => n === seq.current && setError((err as Error).message))
        .finally(() => n === seq.current && setLoading(false));
    }, 120);
    return () => clearTimeout(t);
  }, [search]);
  if (search === null) return { items: [], loading, error };
  // While the latest search is loading, show only earlier results that also match it (instant narrowing,
  // and never a reply that doesn't match what's typed)
  const items = result.search === search ? result.items : result.items.filter((r) => matchesQuickReply(r, search));
  return { items, loading, error };
}

function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((p, i) =>
        p.match ? (
          <mark key={i} className="rounded-sm bg-warning-soft px-px text-ink">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

// WhatsApp Business-style quick replies menu above the message box
export function QuickReplyMenu({
  query,
  items,
  loading,
  error,
  active,
  onHover,
  onPick,
}: {
  query: string;
  items: QuickReply[];
  loading: boolean;
  error: string;
  active: number;
  onHover: (index: number) => void;
  onPick: (reply: QuickReply) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <div
      role="listbox"
      aria-label="Quick replies"
      className="absolute bottom-full left-3 right-3 mb-2 flex max-h-80 flex-col overflow-hidden rounded-2xl border border-line bg-surface text-xs shadow-xl"
    >
      <div className="flex items-center justify-between border-b border-line-soft px-3 py-2">
        <span className="font-semibold text-ink">Quick replies</span>
        <span className="text-[10px] text-faint">↑↓ to move · Enter to insert · Esc to close</span>
      </div>
      {error && <p className="px-3 py-2 text-danger">{error}</p>}
      {!error && items.length === 0 && (
        <p className="px-3 py-2 text-muted">{loading ? 'Searching…' : query ? `No quick replies match "${query}".` : 'No quick replies yet.'}</p>
      )}
      <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
        {items.map((r, i) => (
          <li key={r.id} data-index={i}>
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => onHover(i)}
              // mousedown, so the message box keeps focus
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(r);
              }}
              className={`block w-full px-3 py-1.5 text-left ${i === active ? 'bg-primary-subtle' : 'hover:bg-surface-muted'}`}
            >
              <span className="flex items-center gap-2">
                <span className="font-semibold text-ink">
                  /<Highlighted text={r.shortcut} query={query} />
                </span>
                {r.category && (
                  <span className="rounded bg-surface-strong px-1.5 text-[10px] text-muted">
                    <Highlighted text={r.category.replace(/_/g, ' ')} query={query.replace(/_/g, ' ')} />
                  </span>
                )}
              </span>
              {r.description && (
                <span className="mt-0.5 line-clamp-2 whitespace-pre-line text-[11px] text-muted">
                  <Highlighted text={r.description} query={query} />
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
