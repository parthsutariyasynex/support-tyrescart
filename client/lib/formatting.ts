// WhatsApp text formatting, as WhatsApp itself shows it: *bold*, _italic_, ~strikethrough~, ```monospace```,
// `inline code`, "- " / "* " bulleted lists, "1. " numbered lists and "> " quotes, combinable (*_bold italic_*).
// The text is never changed: it's stored and sent to WhatsApp exactly as typed (the customer's WhatsApp formats it
// the same way), and only displayed formatted here. Anything that doesn't follow the rules stays as typed.
import { linkSegments } from './links';

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold' | 'italic' | 'strike'; children: Inline[] }
  // `inline code` and ```monospace``` (which may span lines): shown as typed, nothing formatted inside
  | { kind: 'code' | 'mono'; text: string };

export type Block =
  | { kind: 'paragraph'; lines: Inline[][] }
  | { kind: 'bullet'; items: Inline[][] }
  | { kind: 'numbered'; items: { number: number; content: Inline[] }[] }
  | { kind: 'quote'; lines: Inline[][] };

const STYLES: Record<string, 'bold' | 'italic' | 'strike'> = { '*': 'bold', _: 'italic', '~': 'strike' };
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/u;
const MAX_DEPTH = 6;
const FENCE = '```';

// Characters inside web addresses: a marker there is part of the address (https://x.com/a_b_c is never italic).
// Formatting markers right after an address close the formatting around it, so they aren't part of it.
function linkMask(text: string) {
  const mask = new Uint8Array(text.length);
  let at = 0;
  for (const seg of linkSegments(text)) {
    if (seg.href) {
      let end = at + seg.text.length;
      while (end > at && '*_~`'.includes(text[end - 1])) end--;
      mask.fill(1, at, end);
    }
    at += seg.text.length;
  }
  return mask;
}

// Where a ``` block that opens at i closes (the start of its closing fence), or -1
function fenceClose(s: string, i: number, to: number) {
  const close = s.indexOf(FENCE, i + 3);
  return close > i + 3 && close + 3 <= to ? close : -1;
}

// A marker opens formatting when text follows it right away and it doesn't sit inside a word
function canOpen(s: string, i: number) {
  const next = s[i + 1];
  if (next === undefined || SPACE.test(next) || next === s[i]) return false;
  return i === 0 || !WORD.test(s[i - 1]);
}

// Its closing marker: on the same line, right after text, not followed by a letter or digit
function findClose(s: string, i: number, to: number, mask: Uint8Array) {
  for (let j = i + 2; j < to; j++) {
    if (s[j] === '\n') return -1;
    if (s[j] === s[i] && !mask[j] && !SPACE.test(s[j - 1]) && (j + 1 >= s.length || !WORD.test(s[j + 1]))) return j;
  }
  return -1;
}

function parseInline(s: string, from: number, to: number, mask: Uint8Array, depth: number): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ kind: 'text', text: buf });
    buf = '';
  };
  let i = from;
  while (i < to) {
    const c = s[i];
    if (!mask[i]) {
      if (s.startsWith(FENCE, i)) {
        const close = fenceClose(s, i, to);
        if (close !== -1) {
          flush();
          out.push({ kind: 'mono', text: s.slice(i + 3, close) });
          i = close + 3;
          continue;
        }
      } else if (c === '`') {
        const close = s.indexOf('`', i + 1);
        if (close > i + 1 && close < to && !s.slice(i + 1, close).includes('\n')) {
          flush();
          out.push({ kind: 'code', text: s.slice(i + 1, close) });
          i = close + 1;
          continue;
        }
      } else if (STYLES[c] && depth < MAX_DEPTH && canOpen(s, i)) {
        const close = findClose(s, i, to, mask);
        if (close !== -1) {
          flush();
          out.push({ kind: STYLES[c], children: parseInline(s, i + 1, close, mask, depth + 1) });
          i = close + 1;
          continue;
        }
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

// Lines, where a ``` block's own line breaks don't count (it stays one piece)
function lineRanges(s: string, mask: Uint8Array) {
  const ranges: [number, number][] = [];
  let start = 0;
  let i = 0;
  while (i < s.length) {
    if (!mask[i] && s.startsWith(FENCE, i)) {
      const close = fenceClose(s, i, s.length);
      if (close !== -1) {
        i = close + 3;
        continue;
      }
    }
    if (s[i] === '\n') {
      ranges.push([start, i]);
      start = i + 1;
    }
    i++;
  }
  ranges.push([start, s.length]);
  return ranges;
}

const BULLET = /^[*-] (?=\S)/;
const NUMBERED = /^(\d{1,9})\. (?=\S)/;
const QUOTE = /^> (?=\S)/;

export function parseFormatting(text: string): Block[] {
  if (!text) return [];
  const mask = linkMask(text);
  const blocks: Block[] = [];
  const last = () => blocks[blocks.length - 1];
  for (const [start, end] of lineRanges(text, mask)) {
    const line = text.slice(start, end);
    const bullet = BULLET.exec(line);
    const numbered = !bullet && NUMBERED.exec(line);
    const quote = !bullet && !numbered && QUOTE.exec(line);
    const prefix = (bullet || numbered || quote || [''])[0].length;
    const content = parseInline(text, start + prefix, end, mask, 0);
    const prev = last();
    if (bullet) {
      if (prev?.kind === 'bullet') prev.items.push(content);
      else blocks.push({ kind: 'bullet', items: [content] });
    } else if (numbered) {
      const item = { number: Number(numbered[1]), content };
      if (prev?.kind === 'numbered') prev.items.push(item);
      else blocks.push({ kind: 'numbered', items: [item] });
    } else if (quote) {
      if (prev?.kind === 'quote') prev.lines.push(content);
      else blocks.push({ kind: 'quote', lines: [content] });
    } else if (prev?.kind === 'paragraph') prev.lines.push(content);
    else blocks.push({ kind: 'paragraph', lines: [content] });
  }
  return blocks;
}

// --- The formatting toolbar: changes to the message box's text and selection ---

export type Edit = { text: string; start: number; end: number };
export type InlineStyle = 'bold' | 'italic' | 'strike' | 'mono' | 'code';
export type LineStyle = 'bullet' | 'numbered' | 'quote';
export const MARKERS: Record<InlineStyle, string> = { bold: '*', italic: '_', strike: '~', mono: FENCE, code: '`' };

// Wraps the selection in the style's markers, or takes them off when it already has them. Spaces at the edges of
// the selection stay outside (WhatsApp needs the markers right next to the text); each line is wrapped on its own,
// except monospace, which may span lines. Without a selection: a pair of markers with the cursor between them.
export function toggleInline(text: string, start: number, end: number, style: InlineStyle): Edit {
  const m = MARKERS[style];
  const n = m.length;
  if (start === end) {
    if (text.slice(start - n, start) === m && text.slice(end, end + n) === m)
      return { text: text.slice(0, start - n) + text.slice(end + n), start: start - n, end: start - n }; // an empty pair: removed
    return { text: text.slice(0, start) + m + m + text.slice(end), start: start + n, end: start + n };
  }
  if (text.slice(start - n, start) === m && text.slice(end, end + n) === m)
    return { text: text.slice(0, start - n) + text.slice(start, end) + text.slice(end + n), start: start - n, end: end - n };
  const selected = text.slice(start, end);
  if (selected.length > 2 * n && selected.startsWith(m) && selected.endsWith(m)) {
    const inner = selected.slice(n, -n);
    return { text: text.slice(0, start) + inner + text.slice(end), start, end: start + inner.length };
  }
  const wrap = (part: string) => {
    const lead = /^\s*/.exec(part)![0];
    const core = part.slice(lead.length).trimEnd();
    return core ? lead + m + core + m + part.slice(lead.length + core.length) : part;
  };
  const wrapped = style === 'mono' ? wrap(selected) : selected.split('\n').map(wrap).join('\n');
  return { text: text.slice(0, start) + wrapped + text.slice(end), start, end: start + wrapped.length };
}

const LINE_PREFIX: Record<LineStyle, RegExp> = { bullet: /^[*-] /, numbered: /^\d+\. /, quote: /^> / };
// Switching between the two kinds of list replaces the prefix; a quote keeps a list inside it
const STRIP: Record<LineStyle, RegExp> = { bullet: /^([*-] |\d+\. )/, numbered: /^([*-] |\d+\. )/, quote: /^> / };

// Turns every line the selection touches into list items (numbered 1, 2, 3…) or quotes, or back to plain lines
// when they all already are. Empty lines are left alone, unless it's the only line (ready to type the first item).
export function toggleLines(text: string, start: number, end: number, style: LineStyle): Edit {
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const lastChar = end > start && text[end - 1] === '\n' ? end - 1 : end; // a selection ending at a line break
  let to = text.indexOf('\n', lastChar);
  if (to === -1) to = text.length;
  const lines = text.slice(from, to).split('\n');
  const filled = lines.filter((l) => l.trim());
  const remove = filled.length > 0 && filled.every((l) => LINE_PREFIX[style].test(l));
  let number = 0;
  const prefixLen: number[] = [];
  const next = lines.map((l) => {
    const old = (STRIP[style].exec(l) ?? [''])[0].length;
    if (!l.trim() && lines.length > 1) {
      prefixLen.push(0);
      return l;
    }
    const bare = l.slice(old);
    const prefix = remove ? '' : style === 'bullet' ? '- ' : style === 'numbered' ? `${++number}. ` : '> ';
    prefixLen.push(prefix.length - old);
    return prefix + bare;
  });
  const block = next.join('\n');
  const result = text.slice(0, from) + block + text.slice(to);
  if (start === end) {
    // One line: the cursor stays on its text, or goes right after the new prefix when it was in the old one
    const oldPrefix = (STRIP[style].exec(lines[0]) ?? [''])[0].length;
    const cursor = start - from <= oldPrefix ? from + oldPrefix + prefixLen[0] : start + prefixLen[0];
    return { text: result, start: cursor, end: cursor };
  }
  return { text: result, start: from, end: from + block.length };
}

// Keyboard shortcuts, as in WhatsApp Desktop: Ctrl/⌘+B bold, +I italic, +Shift+X strikethrough, +Shift+M monospace
export function shortcutStyle(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): InlineStyle | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (!e.shiftKey && key === 'b') return 'bold';
  if (!e.shiftKey && key === 'i') return 'italic';
  if (e.shiftKey && key === 'x') return 'strike';
  if (e.shiftKey && key === 'm') return 'mono';
  return null;
}

// --- While typing: the message box shows the formatting too (like WhatsApp), with the markers still there ---

export const BOLD = 1;
export const ITALIC = 2;
export const STRIKE = 4;
export const CODE = 8;
export const MARKER = 16; // a * _ ~ ` that formats (shown faded)
export type StyledRun = { text: string; style: number };

const BIT: Record<'bold' | 'italic' | 'strike', number> = { bold: BOLD, italic: ITALIC, strike: STRIKE };

// The same rules as parseInline, but marking every character (nothing is left out) with how it looks
function markInline(s: string, from: number, to: number, mask: Uint8Array, depth: number, flags: Uint8Array, outer: number) {
  let i = from;
  while (i < to) {
    const c = s[i];
    if (!mask[i]) {
      if (s.startsWith(FENCE, i)) {
        const close = fenceClose(s, i, to);
        if (close !== -1) {
          flags.fill(outer | MARKER, i, i + 3);
          flags.fill(outer | CODE, i + 3, close);
          flags.fill(outer | MARKER, close, close + 3);
          i = close + 3;
          continue;
        }
      } else if (c === '`') {
        const close = s.indexOf('`', i + 1);
        if (close > i + 1 && close < to && !s.slice(i + 1, close).includes('\n')) {
          flags[i] = outer | MARKER;
          flags.fill(outer | CODE, i + 1, close);
          flags[close] = outer | MARKER;
          i = close + 1;
          continue;
        }
      } else if (STYLES[c] && depth < MAX_DEPTH && canOpen(s, i)) {
        const close = findClose(s, i, to, mask);
        if (close !== -1) {
          const inner = outer | BIT[STYLES[c]];
          flags[i] = inner | MARKER;
          markInline(s, i + 1, close, mask, depth + 1, flags, inner);
          flags[close] = inner | MARKER;
          i = close + 1;
          continue;
        }
      }
    }
    flags[i] = outer;
    i++;
  }
}

// The text in runs of the same look; joined back they are exactly the text (every character, markers included)
export function styledRuns(text: string): StyledRun[] {
  if (!text) return [];
  const mask = linkMask(text);
  const flags = new Uint8Array(text.length);
  for (const [start, end] of lineRanges(text, mask)) markInline(text, start, end, mask, 0, flags, 0);
  const runs: StyledRun[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++)
    if (i === text.length || flags[i] !== flags[start]) {
      runs.push({ text: text.slice(start, i), style: flags[start] });
      start = i;
    }
  return runs;
}
