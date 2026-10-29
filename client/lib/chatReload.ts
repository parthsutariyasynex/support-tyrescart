import { type Message, mergeLoadedMessages } from './inbox';

// After the live connection drops and comes back (Wi-Fi change, sleep, an API restart), Socket.IO starts a new session:
// the message:new events sent while it was down are gone, and the open chat would stay without them until reopened.
// So on a reconnect the open chat's newest page is loaded again and merged into what's on screen.

// The newest page, loaded again, merged into the chat on screen: its messages in their newest copies, those that
// arrived meanwhile added (mergeLoadedMessages), and older ones already on screen (earlier pages loaded with "load
// earlier messages") kept. continuous: false when the page doesn't reach back to what was on screen (more came in than
// a page holds): then the chat starts again from this page (the caller resets "load earlier" to it), so nothing is
// silently skipped in between.
export function mergeReloadedMessages(loaded: Message[], loadedHasOlder: boolean, onScreen: Message[], conversationId: string) {
  const merged = mergeLoadedMessages(loaded, onScreen, conversationId);
  const mine = onScreen.filter((m) => m.conversationId === conversationId);
  const loadedIds = new Set(loaded.map((m) => m.id));
  const reachesBack = !loadedHasOlder || !mine.length || mine.some((m) => loadedIds.has(m.id));
  if (!reachesBack) return { messages: merged, continuous: false };
  const mergedIds = new Set(merged.map((m) => m.id));
  const oldest = loaded[0]?.createdAt;
  const older = mine.filter((m) => !mergedIds.has(m.id) && (oldest === undefined || m.createdAt < oldest));
  return { messages: [...older, ...merged], continuous: true };
}

type Page = { nodes: Message[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

// Reloads the open chat on reconnect. One request at a time: a reconnect while one is on its way asks for exactly one
// more after it (repeated reconnects don't pile up requests); an answer for a chat that is no longer open is ignored.
export function createOpenChatReloader(opts: {
  openChatId: () => string | null;
  fetchPage: (conversationId: string) => Promise<Page>;
  apply: (conversationId: string, page: Page) => void;
}) {
  let running = false;
  let again = false;
  const reload = (): void => {
    if (!opts.openChatId()) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    const id = opts.openChatId()!;
    opts
      .fetchPage(id)
      .then((page) => {
        if (opts.openChatId() === id) opts.apply(id, page); // switched chats meanwhile: that one loads on its own
      })
      .catch(() => {}) // still offline or failed: the next reconnect tries again
      .finally(() => {
        running = false;
        if (again) {
          again = false;
          reload();
        }
      });
  };
  return reload;
}
