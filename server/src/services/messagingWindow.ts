// WhatsApp's 24-hour customer service window: free-form messages (text, files, voice notes, reactions) can be sent
// only within 24 hours of the customer's last message; after that only approved templates. A new message from the
// customer opens it again. Shared by sending (checkCanSend) and the live "typing…" indicator.

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export const windowOpen = (lastInboundAt: Date | null | undefined, now = Date.now()) => !!lastInboundAt && now - lastInboundAt.getTime() < WINDOW_MS;

// When the customer's message was sent, from Meta's webhook timestamp (Unix seconds), so the window runs from the
// customer's own message rather than from when the webhook reached us (Meta retries late deliveries). A missing or
// unreadable timestamp, or one in the future (clock skew), falls back to now.
export function inboundSentAt(timestamp: unknown, now = new Date()): Date {
  const seconds = typeof timestamp === 'string' && /^\d{1,12}$/.test(timestamp) ? Number(timestamp) : typeof timestamp === 'number' ? timestamp : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return now;
  const at = new Date(seconds * 1000);
  return at.getTime() > now.getTime() ? now : at;
}

// The chat's lastInboundAt after this message: never earlier than what it was (a late retry of an older message
// doesn't shorten the window)
export const laterOf = (current: Date | null | undefined, next: Date) => (current && current.getTime() > next.getTime() ? current : next);
