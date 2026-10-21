// Web addresses in message text, so the chat can show them as links (opened in a new tab). Only http(s) and
// "www." addresses become links; anything else (javascript:, mailto:, …) stays plain text.

// http(s)://… or www.…, up to the next space or quote/angle bracket
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
// Punctuation that usually ends the sentence rather than the address ("see tyrescart.ae.")
const TRAILING = /[.,!?;:'"]+$/;

// A closing bracket belongs to the address only when it opens one too: (https://x.com/a_(b)) keeps "(b)"
function trimEnd(url: string) {
  let u = url.replace(TRAILING, '');
  for (const [open, close] of [['(', ')'], ['[', ']']]) {
    while (u.endsWith(close) && u.split(open).length < u.split(close).length) u = u.slice(0, -1).replace(TRAILING, '');
  }
  return u;
}

export type LinkSegment = { text: string; href?: string };

export function linkSegments(text: string): LinkSegment[] {
  if (!text) return [{ text }];
  const out: LinkSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const raw = trimEnd(m[0]);
    if (!raw || raw === 'www.') continue;
    const start = m.index!;
    if (start > last) out.push({ text: text.slice(last, start) });
    const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const u = new URL(href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
      out.push({ text: raw, href: u.href });
    } catch {
      out.push({ text: raw });
    }
    last = start + raw.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.length ? out : [{ text }];
}
