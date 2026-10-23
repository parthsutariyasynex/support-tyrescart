// WhatsApp's 24-hour customer service window, as the chat screen shows it: normal messages within 24 hours of the
// customer's last message, then only approved templates until they write again. The server enforces the same rule
// (WINDOW_CLOSED); this only decides what the message box offers.

export const WINDOW_MS = 24 * 60 * 60 * 1000;

// When the customer last wrote: the chat's lastInboundAt, exactly as the server has it (from Meta's timestamp of the
// customer's message; kept live by message:new). Never a message's createdAt: that's when the webhook reached us,
// which for a late delivery can be hours after the customer wrote, and the server would refuse the reply.
export function lastCustomerMessageAt(lastInboundAt: string | null | undefined): number | null {
  const at = lastInboundAt ? Date.parse(lastInboundAt) : NaN;
  return Number.isNaN(at) ? null : at;
}

// The server refused a send because the 24-hour window had closed (its clock decides): GraphQL WINDOW_CLOSED, or the
// same message from the file upload routes
export const isWindowClosedError = (err: unknown, code?: string) =>
  code === 'WINDOW_CLOSED' || (err instanceof Error && /24-hour window closed/i.test(err.message));

export const windowOpen = (lastAt: number | null, now = Date.now()) => lastAt !== null && now - lastAt < WINDOW_MS;

// Milliseconds until it closes (null: already closed, or the customer never wrote)
export const msUntilClose = (lastAt: number | null, now = Date.now()) => (windowOpen(lastAt, now) ? lastAt! + WINDOW_MS - now : null);
