// Message box keys, WhatsApp-style: Enter sends, Shift+Enter starts a new line. Nothing happens while an
// input method (IME) is composing, so Enter that confirms a character never sends half a word.
export function enterAction(e: { key: string; shiftKey: boolean; isComposing?: boolean }): 'send' | 'newline' | null {
  if (e.key !== 'Enter' || e.isComposing) return null;
  return e.shiftKey ? 'newline' : 'send';
}

// Grow the message box with its text, up to `maxPx`, then scroll
export function fitHeight(el: HTMLTextAreaElement, maxPx: number) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, maxPx)}px`;
  el.style.overflowY = el.scrollHeight > maxPx ? 'auto' : 'hidden';
}
