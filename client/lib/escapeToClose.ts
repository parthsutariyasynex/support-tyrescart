// Esc leaves the open chat and goes back to the chat list, as in WhatsApp. Only a plain Esc with nothing else to
// close: never while a menu, dropdown or dialog is open (it closes that instead), never while typing in a field
// (it clears or closes that field instead), and never when something else already handled it. The empty message
// box counts as "not typing": it has the cursor whenever a chat is open, so Esc there leaves the chat as well;
// with text in it (or while replying / editing) Esc stays in the chat.

// Open popovers and dialogs mark themselves with one of these
export const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"]';

export type EscapeTarget = {
  tagName?: string;
  isContentEditable?: boolean;
  // The chat's message box: whether it's empty (null for any other element)
  composerEmpty?: boolean | null;
};

export type EscapeEvent = {
  key: string;
  repeat: boolean;
  isComposing: boolean; // IME composition: Esc cancels that
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
};

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export function escapeClosesChat(e: EscapeEvent, target: EscapeTarget | null, overlayOpen: boolean) {
  if (e.key !== 'Escape' || e.repeat || e.isComposing || e.defaultPrevented) return false;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  if (overlayOpen) return false;
  if (target?.composerEmpty === true) return true;
  if (target?.composerEmpty === false) return false;
  if (target?.isContentEditable || (target?.tagName && EDITABLE.has(target.tagName.toUpperCase()))) return false;
  return true;
}
