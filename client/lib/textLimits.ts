// The only text limits: WhatsApp's own (what it accepts in one message) and the database's (what a column holds; the
// server sends those, e.g. remarkMaxLength / replyMaxLength). Text over a limit is never cut: it stays as typed, the
// counter turns red and sending / saving waits until it's shortened. The server checks the same limits again.

// One WhatsApp text message (chat replies, edits, automatic replies); captions: CAPTION_MAX in media.ts
export const WHATSAPP_TEXT_MAX = 4096;

export const overLimit = (text: string, max: number | null | undefined) => max != null && text.length > max;

// "4200 / 4096 characters: WhatsApp allows up to 4096 in one message. Shorten it or send it in parts."
export const tooLongText = (text: string, max: number, what = 'WhatsApp allows up to') =>
  `${text.length.toLocaleString('en')} / ${max.toLocaleString('en')} characters: ${what} ${max.toLocaleString('en')}. Shorten it or send it in parts.`;
