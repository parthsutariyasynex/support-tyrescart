// @mentions in "Add note": typing @ (at the start or after a space) opens the list of teammates; picking one puts
// "@Their Name " in the note at the cursor. Notes are internal, so only the team ever sees the mention.

// The @word being typed right before the cursor: where its @ is and the text after it (letters, digits, . _ -), or
// null when the cursor isn't right after one ("email@x" doesn't count: the @ must start a word)
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([\p{L}\p{N}._-]*)$/u.exec(before);
  return m ? { start: before.length - m[2].length - 1, query: m[2] } : null;
}

// Teammates whose name or email matches what's typed after @: name starts with it first, then a word of the name,
// then anywhere in the name or email
export function matchMembers<T extends { name: string; email: string }>(members: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return members;
  const rank = (m: T) => {
    const name = m.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (name.split(/\s+/).some((w) => w.startsWith(q))) return 1;
    if (name.includes(q) || m.email.toLowerCase().includes(q)) return 2;
    return -1;
  };
  return members
    .map((m) => ({ m, r: rank(m) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r)
    .map((x) => x.m);
}

// The text with "@query" replaced by "@Name ", and where the cursor goes (right after it)
export function insertMention(text: string, at: { start: number; query: string }, name: string) {
  const end = at.start + 1 + at.query.length;
  const mention = `@${name} `;
  const rest = text.slice(end).replace(/^ /, ''); // don't leave two spaces
  return { text: text.slice(0, at.start) + mention + rest, caret: at.start + mention.length };
}

// A note split into plain text and @mentions of these teammates (to show the mentions highlighted). Longer names
// first, so "@deep patel" isn't taken as "@deep"; a mention must start a word.
export function mentionPieces(text: string, names: string[]): { text: string; mention: boolean }[] {
  const sorted = [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!sorted.length) return [{ text, mention: false }];
  const escape = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\s)(@(?:${sorted.map(escape).join('|')}))(?![\\p{L}\\p{N}])`, 'gu');
  const out: { text: string; mention: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index! + m[1].length;
    if (start > last) out.push({ text: text.slice(last, start), mention: false });
    out.push({ text: m[2], mention: true });
    last = start + m[2].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), mention: false });
  return out;
}
