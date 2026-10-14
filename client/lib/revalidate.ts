import type { Socket } from 'socket.io-client';

// Refresh data when the person comes back: the browser tab becomes visible again after being hidden, or the
// live connection reconnects (both mean updates may have been missed). At most once per REVALIDATE_MIN_GAP_MS,
// so flipping between tabs quickly doesn't fire a burst of requests.
export const REVALIDATE_MIN_GAP_MS = 5_000;

export function shouldRevalidate(lastAt: number, now: number, minGapMs = REVALIDATE_MIN_GAP_MS) {
  return now - lastAt >= minGapMs;
}

export function revalidateOnReturn(refresh: () => void, socket?: Socket | null, minGapMs = REVALIDATE_MIN_GAP_MS) {
  let lastAt = Date.now(); // the page has just loaded its data
  let wasHidden = typeof document !== 'undefined' && document.hidden;
  const run = () => {
    const now = Date.now();
    if (!shouldRevalidate(lastAt, now, minGapMs)) return;
    lastAt = now;
    refresh();
  };
  const onVisibility = () => {
    if (document.hidden) {
      wasHidden = true;
      return;
    }
    if (wasHidden) {
      wasHidden = false;
      run();
    }
  };
  const onFocus = () => {
    if (!document.hidden) run();
  };
  let firstConnect = socket ? !socket.connected : false;
  const onConnect = () => {
    if (firstConnect) {
      firstConnect = false; // the initial connection: the page already loaded everything
      return;
    }
    run(); // a reconnect: events may have been missed while offline
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);
  socket?.on('connect', onConnect);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
    socket?.off('connect', onConnect);
  };
}
