// Replies on their way, shown in the chat until the server answers: "Sending…" at once (so pressing Send always shows
// something), then either gone (the saved message takes its place, with its own ✓ / ⚠) or failed with the actual
// reason. A failure after no answer in time is "unknown": the reply may still have been sent, so the agent is told to
// check before sending again.

export type PendingSend = {
  requestId: string;
  conversationId: string;
  body: string;
  startedAt: number;
  state: 'sending' | 'failed' | 'unknown';
  error?: string;
};

export type PendingAction =
  | { type: 'start'; send: Omit<PendingSend, 'state' | 'error'> }
  | { type: 'done'; requestId: string }
  | { type: 'fail'; requestId: string; error: string; unknown?: boolean }
  | { type: 'dismiss'; requestId: string };

export function pendingReducer(list: PendingSend[], a: PendingAction): PendingSend[] {
  switch (a.type) {
    case 'start':
      return [...list.filter((p) => p.requestId !== a.send.requestId), { ...a.send, state: 'sending' }];
    case 'done':
    case 'dismiss':
      return list.filter((p) => p.requestId !== a.requestId);
    case 'fail':
      return list.map((p) => (p.requestId === a.requestId ? { ...p, state: a.unknown ? 'unknown' : 'failed', error: a.error } : p));
  }
}

// The replies to show in one chat
export const pendingIn = (list: PendingSend[], conversationId: string) => list.filter((p) => p.conversationId === conversationId);

// The line under a pending reply
export function pendingLabel(p: PendingSend) {
  if (p.state === 'sending') return 'Sending…';
  if (p.state === 'unknown') return `Not confirmed: ${p.error ?? 'no answer from the server'}`;
  return `Not sent: ${p.error ?? 'unknown error'}`;
}
