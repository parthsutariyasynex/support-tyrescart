// Emojis are plain text, so WhatsApp delivers them as typed. The picker (search, categories, skin tones, recently
// used) is emoji-picker-react; see EmojiPicker in app/inbox/composerExtras.tsx.

// Puts text at the cursor (replacing any selection) and says where the cursor goes next. Positions are the
// textarea's (UTF-16 code units), so emojis made of several characters (👍🏽, 🇦🇪, 👨‍👩‍👧) go in whole.
export function insertAt(text: string, insert: string, start: number, end = start) {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  return { text: text.slice(0, s) + insert + text.slice(e), cursor: s + insert.length };
}
