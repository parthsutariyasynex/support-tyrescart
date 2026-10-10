import Link from 'next/link';

export function AuthShell({
  title,
  subtitle,
  children,
  badge = 'Meta Business Partner compatible',
  footerText = "Don't have an account?",
  footerLinkText = 'Create workspace →',
  footerLinkHref = '/register',
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  badge?: string;
  footerText?: string;
  footerLinkText?: string;
  footerLinkHref?: string;
}) {
  return (
    <main className="grid min-h-screen lg:grid-cols-2 bg-canvas">
      {/* Left Column: Form & Auth */}
      <section className="relative flex flex-col justify-between px-6 py-8 sm:px-12 lg:px-16 overflow-hidden">
        {/* Subtle Ambient Radial Glow */}
        <div className="pointer-events-none absolute -left-20 -top-20 h-96 w-96 rounded-full bg-primary-soft/40 blur-3xl" />

        {/* Top Logo */}
        <div className="relative z-10 flex items-center justify-between">
          <Link href="/" className="group flex items-center gap-1 text-2xl font-bold tracking-tight text-ink">
            <span>Tyres</span>
            <span className="text-primary">Cart</span>
            <span className="relative flex items-center justify-center text-primary-hover ml-0.5">
              <svg viewBox="0 0 24 24" className="h-4.5 w-4.5 fill-none stroke-accent stroke-[3.5]" strokeLinecap="round">
                <circle cx="12" cy="12" r="8" />
              </svg>
            </span>
          </Link>
        </div>

        {/* Center Container */}
        <div className="relative z-10 mx-auto my-auto flex w-full max-w-[440px] flex-col items-center py-10">
          {/* Top Badge */}
          <div className="mb-4 inline-flex items-center gap-1.5 rounded-full border border-primary-soft-border bg-primary-soft/80 px-3.5 py-1 text-xs font-semibold text-primary shadow-xs backdrop-blur-xs">
            <svg className="h-3.5 w-3.5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            <span>{badge}</span>
          </div>

          {/* White Card */}
          <div className="w-full rounded-[28px] border border-card-border bg-surface p-7 sm:p-9 shadow-[0_20px_50px_-15px_color-mix(in_srgb,var(--color-primary)_6%,transparent)]">
            <h1 className="text-[28px] font-bold tracking-tight text-ink sm:text-[32px]">{title}</h1>
            <p className="mt-1 text-sm text-muted">{subtitle}</p>

            <div className="mt-7">{children}</div>

            <div className="mt-6 text-center text-[13px] text-muted">
              {footerText}{' '}
              <Link href={footerLinkHref} className="font-semibold text-primary transition-colors hover:text-primary-hover">
                {footerLinkText}
              </Link>
            </div>
          </div>

          {/* Under-Card Feature Badges */}
          <div className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[12px] font-medium text-body-soft">
            <div className="flex items-center gap-1.5">
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary-soft text-[10px] text-primary font-bold">✓</span>
              <span>Official Cloud API</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary-soft text-[10px] text-primary font-bold">✓</span>
              <span>5-minute setup</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary-soft text-[10px] text-primary font-bold">✓</span>
              <span>No card to start</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="relative z-10 flex items-center justify-between text-xs text-faint">
          <div className="flex items-center gap-4">
            <Link href="#" className="hover:text-body-soft transition-colors">Privacy</Link>
            <Link href="#" className="hover:text-body-soft transition-colors">Terms</Link>
          </div>
          <div>© {new Date().getFullYear()} support-tyrescart</div>
        </div>
      </section>

      {/* Right Column: Hero Visual Showcase (WhatsApp Forest/Teal Gradient) */}
      <aside className="relative hidden lg:flex flex-col justify-between overflow-hidden bg-linear-to-br from-primary-hover via-primary to-primary-dark p-12 xl:p-16 text-on-primary">
        {/* Decorative Background Elements */}
        <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-accent/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -left-32 h-[500px] w-[500px] rounded-full border-[60px] border-on-primary/[0.04]" />
        <div className="pointer-events-none absolute right-16 top-1/3 h-80 w-80 rounded-full border border-on-primary/10" />

        {/* Floating Abstract Shapes */}
        <div className="pointer-events-none absolute top-24 left-16 h-8 w-8 rounded-lg border border-on-primary/20" />
        <div className="pointer-events-none absolute top-40 left-24 h-5 w-5 rounded-md border border-on-primary/20" />

        {/* Top Right Decorative Pill Bars */}
        <div className="absolute top-8 right-8 flex gap-1.5 opacity-60">
          <span className="h-9 w-1.5 rounded-full bg-on-primary/40" />
          <span className="h-9 w-1.5 rounded-full bg-accent/80" />
          <span className="h-9 w-1.5 rounded-full bg-on-primary/50" />
          <span className="h-9 w-1.5 rounded-full bg-accent/90" />
          <span className="h-9 w-1.5 rounded-full bg-on-primary/40" />
        </div>

        {/* Bottom Right Dot Grid */}
        <div className="pointer-events-none absolute bottom-8 right-8 grid grid-cols-6 gap-2 opacity-30">
          {Array.from({ length: 36 }).map((_, i) => (
            <span key={i} className="h-1.5 w-1.5 rounded-full bg-surface" />
          ))}
        </div>

        {/* Main Center Floating Showcase */}
        <div className="relative z-10 mx-auto my-auto flex w-full max-w-md flex-col items-center">
          {/* Main Card: New Broadcast */}
          <div className="relative w-full max-w-[340px] rounded-2xl bg-surface p-5 text-ink-soft shadow-[0_25px_50px_-12px_color-mix(in_srgb,var(--color-shadow)_35%,transparent)]">
            <div className="flex items-center justify-between pb-3 border-b border-line-soft">
              <span className="text-sm font-semibold text-ink">New broadcast</span>
              <span className="rounded-full bg-chat-bg px-2 py-0.5 text-[10px] font-bold tracking-wide text-primary uppercase">Draft</span>
            </div>

            <div className="mt-3.5 space-y-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-faint">Audience</span>
                <span className="font-semibold text-body">VIP buyers · 2,480</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-faint">Template</span>
                <span className="rounded bg-surface-strong px-2 py-0.5 font-mono text-[11px] text-body">order_shipped</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-faint">Send</span>
                <span className="font-semibold text-body">Today, 6:00 PM</span>
              </div>
            </div>

            <div className="mt-4 flex items-center gap-2">
              <button type="button" className="flex-1 rounded-lg bg-primary py-2 text-center text-xs font-semibold text-on-primary shadow-xs transition hover:bg-primary-hover">
                Schedule broadcast
              </button>
              <button type="button" className="flex h-8 w-8 items-center justify-center rounded-lg border border-line text-faint hover:text-body-soft transition">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
              </button>
            </div>
          </div>

          {/* Attached Sub-Cards floating underneath */}
          <div className="mt-2.5 flex w-full max-w-[340px] items-stretch gap-2.5">
            {/* Left metric card */}
            <div className="flex-1 rounded-xl bg-surface p-3 shadow-lg">
              <span className="block text-[10px] font-medium text-faint">Delivered this week</span>
              <span className="block text-base font-bold text-ink mt-0.5">12,480</span>
              <div className="mt-2 h-1.5 w-full rounded-full bg-surface-strong overflow-hidden">
                <div className="h-full w-[82%] rounded-full bg-accent" />
              </div>
            </div>

            {/* Right metric card */}
            <div className="flex items-center gap-3 rounded-xl bg-surface p-3 shadow-lg min-w-[130px]">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-soft text-primary">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
              </div>
              <div>
                <span className="block text-base font-bold text-ink leading-tight">86%</span>
                <span className="block text-[10px] text-faint">read rate</span>
              </div>
            </div>
          </div>

          {/* Hero Typography */}
          <div className="mt-10 text-center max-w-md">
            <h2 className="text-2xl xl:text-[28px] font-bold leading-tight tracking-tight text-on-primary">
              Run WhatsApp the way modern businesses do.
            </h2>
            <p className="mt-3 text-xs xl:text-sm leading-relaxed text-on-primary/85">
              Templates, broadcasts, shared inbox, and automations — built directly on the official WhatsApp Business Cloud API.
            </p>
          </div>
        </div>

        {/* Bottom Metrics Bar */}
        <div className="relative z-10 grid grid-cols-3 border-t border-on-primary/15 pt-6 text-center">
          <div>
            <div className="text-xl xl:text-2xl font-bold tracking-tight text-on-primary">98%</div>
            <div className="mt-0.5 text-[11px] text-on-primary/70">Messages delivered</div>
          </div>
          <div>
            <div className="text-xl xl:text-2xl font-bold tracking-tight text-on-primary">2.1s</div>
            <div className="mt-0.5 text-[11px] text-on-primary/70">Median first reply</div>
          </div>
          <div>
            <div className="text-xl xl:text-2xl font-bold tracking-tight text-on-primary">24/7</div>
            <div className="mt-0.5 text-[11px] text-on-primary/70">Bots answering</div>
          </div>
        </div>
      </aside>
    </main>
  );
}

export const inputClass =
  'w-full rounded-xl border border-line bg-input px-3.5 py-2.5 text-sm text-ink outline-hidden transition placeholder:text-faint hover:bg-surface focus:border-primary-hover focus:bg-surface focus:ring-3 focus:ring-primary-hover/15';

export const buttonClass =
  'w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-on-primary shadow-sm transition hover:bg-primary-hover active:scale-[0.99] disabled:opacity-60 flex items-center justify-center gap-2 cursor-pointer';



// Fixed-height slot for a form's error or notice. It's always there (empty when there's nothing to say),
// so messages appearing or disappearing never move the form or the page. Fits two lines.
export function FormMessage({ tone = 'error', children }: { tone?: 'error' | 'success'; children?: React.ReactNode }) {
  return (
    <div className="h-[54px]" aria-live="polite">
      {children && (
        <div
          className={`line-clamp-2 rounded-xl border px-3.5 py-2.5 text-xs font-medium ${
            tone === 'error' ? 'border-danger-border bg-danger-soft/80 text-danger' : 'border-primary-soft-border bg-primary-subtle text-primary'
          }`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
