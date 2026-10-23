// WhatsApp's 24-hour customer service window, as the chat screen shows it: normal messages within 24 hours of the
// customer's last message, then only approved templates until they write again. The server enforces the same rule
// (WINDOW_CLOSED); this only decides what the message box offers.

export const WINDOW_MS = 24 * 60 * 60 * 1000;

// When the customer last wrote: the chat's lastInboundAt, or a newer customer message that has just arrived live
export function lastCustomerMessageAt(lastInboundAt: string | null | undefined, messages: { direction: string; createdAt: string }[] = []): number | null {
  let latest = lastInboundAt ? Date.parse(lastInboundAt) : NaN;
  for (const m of messages) if (m.direction === 'in') latest = Number.isNaN(latest) ? Date.parse(m.createdAt) : Math.max(latest, Date.parse(m.createdAt));
  return Number.isNaN(latest) ? null : latest;
}

export const windowOpen = (lastAt: number | null, now = Date.now()) => lastAt !== null && now - lastAt < WINDOW_MS;

// Milliseconds until it closes (null: already closed, or the customer never wrote)
export const msUntilClose = (lastAt: number | null, now = Date.now()) => (windowOpen(lastAt, now) ? lastAt! + WINDOW_MS - now : null);
