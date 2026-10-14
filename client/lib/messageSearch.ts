import type { Message } from './inbox';

// "Search in conversation": matches over the messages loaded in the open chat (case-insensitive substring of the
// text; deleted messages have no text). Oldest first, so ↑ walks back in time and ↓ forward, like WhatsApp.
export function findMessageMatches(messages: Pick<Message, 'id' | 'body' | 'deletedAt'>[], query: string): string[] {
  const term = query.trim().toLowerCase();
  if (!term) return [];
  return messages.filter((m) => !m.deletedAt && (m.body || '').toLowerCase().includes(term)).map((m) => m.id);
}

// Splits text into plain and matching segments for highlighting (case-insensitive, keeps the original casing)
export function highlightSegments(text: string, query: string): { text: string; match: boolean }[] {
  const term = query.trim().toLowerCase();
  if (!term || !text) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const out: { text: string; match: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    const j = lower.indexOf(term, i);
    if (j === -1) {
      out.push({ text: text.slice(i), match: false });
      break;
    }
    if (j > i) out.push({ text: text.slice(i, j), match: false });
    out.push({ text: text.slice(j, j + term.length), match: true });
    i = j + term.length;
  }
  return out;
}
