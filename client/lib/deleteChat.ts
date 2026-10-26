// "Delete chat" (like WhatsApp): for the person who deletes it only. Choosing Delete chat only asks; nothing is sent
// until they press Delete in the confirmation. Cancel (or Esc, or clicking outside) leaves everything as it was.
// The server keeps the chat, its messages and files; it just leaves this person's list until a newer message.

export type DeleteChatState = {
  // The chat waiting for confirmation (null: no dialog)
  conversationId: string | null;
  busy: boolean;
  error: string;
};

export const NO_DELETE: DeleteChatState = { conversationId: null, busy: false, error: '' };

export function createDeleteChat({
  remove,
  onDeleted,
  onChange,
}: {
  remove: (conversationId: string) => Promise<unknown>; // the server call
  onDeleted: (conversationId: string) => void; // take it out of the list (and close it if open)
  onChange: (state: DeleteChatState) => void;
}) {
  let state = NO_DELETE;
  const set = (next: DeleteChatState) => {
    state = next;
    onChange(state);
  };
  return {
    // Delete chat was chosen: show the confirmation
    ask(conversationId: string) {
      if (!state.busy) set({ conversationId, busy: false, error: '' });
    },
    cancel() {
      if (!state.busy) set(NO_DELETE);
    },
    // Delete pressed in the confirmation. Pressing twice still deletes once; a failure keeps the dialog open with why.
    async confirm() {
      const id = state.conversationId;
      if (!id || state.busy) return false;
      set({ conversationId: id, busy: true, error: '' });
      try {
        await remove(id);
      } catch (err) {
        set({ conversationId: id, busy: false, error: (err as Error).message || "Couldn't delete the chat" });
        return false;
      }
      set(NO_DELETE);
      onDeleted(id);
      return true;
    },
    get state() {
      return state;
    },
  };
}

// The list without the deleted chat
export const withoutChat = <T extends { id: string }>(list: T[], conversationId: string) => list.filter((c) => c.id !== conversationId);

export function deleteChatText(name: string) {
  return {
    title: `Delete chat with ${name}?`,
    body: "The chat will be removed from your chat list only. Messages, files and history are kept, and your teammates still see the chat. It comes back if a new message arrives.",
  };
}
