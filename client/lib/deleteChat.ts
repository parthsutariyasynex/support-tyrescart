// "Delete chat" (admin-only): permanently deletes the contact behind this chat — not just this user's view of it.
// Choosing Delete chat only asks; nothing is sent until Delete is pressed in the confirmation. Cancel (or Esc, or
// clicking outside) leaves everything as it was. Once confirmed it cannot be undone: the contact, this chat, its
// messages and files are gone for the whole workspace, not just the admin's own list.

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
    body: `${name} and their entire chat history — messages and files — will be permanently deleted for the whole workspace. This cannot be undone.`,
  };
}
