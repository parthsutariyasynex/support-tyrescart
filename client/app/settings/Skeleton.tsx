// Placeholder with the shape of a settings table while it loads, so the page doesn't jump when the rows arrive
export function TableSkeleton({ rows = 6, className = 'mt-5' }: { rows?: number; className?: string }) {
  return (
    <div className={`${className} overflow-hidden rounded-xl border border-line bg-surface`} aria-busy="true" aria-label="Loading">
      <div className="h-11 border-b border-line bg-surface-muted" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 border-b border-line-soft px-4 py-3.5 last:border-b-0">
          <div className="h-4 w-4 animate-pulse rounded bg-surface-strong" />
          <div className="h-4 animate-pulse rounded bg-surface-strong" style={{ width: `${30 + ((i * 17) % 35)}%` }} />
          <div className="ml-auto h-4 w-16 animate-pulse rounded bg-surface-strong" />
        </div>
      ))}
    </div>
  );
}
