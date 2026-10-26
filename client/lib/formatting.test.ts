import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BOLD, CODE, ITALIC, MARKER, STRIKE, type Block, type Inline, parseFormatting, shortcutStyle, styledRuns, toggleInline, toggleLines } from './formatting';

describe('styledRuns: the message box shows formatting while you type', () => {
  const runs = (text: string) => styledRuns(text).map((r) => [r.text, r.style]);
  test('*abcd* is bold, its markers faded; the text is exactly what was typed', () => {
    assert.deepEqual(runs('Hi *abcd* ok'), [
      ['Hi ', 0],
      ['*', BOLD | MARKER],
      ['abcd', BOLD],
      ['*', BOLD | MARKER],
      [' ok', 0],
    ]);
  });
  test('italic, strikethrough, inline code, monospace, and combined', () => {
    assert.deepEqual(runs('_i_'), [['_', ITALIC | MARKER], ['i', ITALIC], ['_', ITALIC | MARKER]]);
    assert.deepEqual(runs('~s~'), [['~', STRIKE | MARKER], ['s', STRIKE], ['~', STRIKE | MARKER]]);
    assert.deepEqual(runs('`c`'), [['`', MARKER], ['c', CODE], ['`', MARKER]]);
    assert.deepEqual(runs('```m```'), [['```', MARKER], ['m', CODE], ['```', MARKER]]);
    assert.deepEqual(runs('*_x_*'), [['*', BOLD | MARKER], ['_', BOLD | ITALIC | MARKER], ['x', BOLD | ITALIC], ['_', BOLD | ITALIC | MARKER], ['*', BOLD | MARKER]]);
  });
  test('while still typing (no closing marker yet), or where WhatsApp would not format: plain', () => {
    for (const text of ['*abcd', '2*3*4', 'snake_case_name', '* not bold *', 'https://x.ae/a_b_c', '- item', '1. step', '> quote'])
      assert.deepEqual(runs(text), [[text, 0]], text);
  });
  test('every character is kept, in order, so it lines up with the cursor', () => {
    const samples = ['Hi *Bina* 👋\n\n_Tyre_ ~price~: `AED 400`\n- *a*\n```x\ny```\nhttps://x.ae/a_b', '*_~'.repeat(50), '', '\n\n'];
    for (const text of samples) assert.equal(styledRuns(text).map((r) => r.text).join(''), text);
  });
});

// Compact form of a parse, for readable expectations: **b**, _i_, ~s~, `c`, ```m```
const flat = (nodes: Inline[]): string =>
  nodes
    .map((n) =>
      'children' in n ? `<${n.kind}:${flat(n.children)}>` : n.kind === 'text' ? n.text : `<${n.kind}:${n.text}>`,
    )
    .join('');
const one = (text: string) => {
  const b = parseFormatting(text);
  assert.equal(b.length, 1);
  assert.equal(b[0].kind, 'paragraph');
  return (b[0] as Extract<Block, { kind: 'paragraph' }>).lines.map(flat);
};

describe('parseFormatting: inline styles, as WhatsApp shows them', () => {
  test('bold, italic, strikethrough, inline code and monospace', () => {
    assert.deepEqual(one('Hi *Bina*, _thanks_ ~old price~ use `CODE10` or ```205/55 R16```'), [
      'Hi <bold:Bina>, <italic:thanks> <strike:old price> use <code:CODE10> or <mono:205/55 R16>',
    ]);
  });
  test('combined: bold italic, bold strikethrough, all three', () => {
    assert.deepEqual(one('*_both_* ~*gone*~ *_~all~_*'), ['<bold:<italic:both>> <strike:<bold:gone>> <bold:<italic:<strike:all>>>']);
  });
  test('markers must touch the text and sit at word edges; otherwise they stay as typed', () => {
    assert.deepEqual(one('2*3*4 = 24'), ['2*3*4 = 24']); // inside a word
    assert.deepEqual(one('a * not bold * b'), ['a * not bold * b']); // a space after the opening marker
    assert.deepEqual(one('*not bold *'), ['*not bold *']); // a space before the closing one
    assert.deepEqual(one('snake_case_name'), ['snake_case_name']);
    assert.deepEqual(one('**'), ['**']);
    assert.deepEqual(one('*unclosed'), ['*unclosed']);
    assert.deepEqual(one('(*bold*), "_quoted_"!'), ['(<bold:bold>), "<italic:quoted>"!']);
  });
  test('inline styles stay on their line', () => {
    assert.deepEqual(one('*one\ntwo*'), ['*one', 'two*']);
  });
  test('nothing is formatted inside code or monospace', () => {
    assert.deepEqual(one('`*not bold*` ```_not italic_```'), ['<code:*not bold*> <mono:_not italic_>']);
  });
  test('monospace may span lines (one piece, its line breaks kept)', () => {
    const b = parseFormatting('Sizes:\n```205/55 R16\n225/45 R17```\nThanks');
    assert.deepEqual(b.map((x) => x.kind), ['paragraph']);
    assert.deepEqual((b[0] as Extract<Block, { kind: 'paragraph' }>).lines.map(flat), ['Sizes:', '<mono:205/55 R16\n225/45 R17>', 'Thanks']);
  });
  test('web addresses are never broken up by markers inside them; formatting around them works', () => {
    assert.deepEqual(one('https://tyrescart.ae/a_b_c/x*y*z'), ['https://tyrescart.ae/a_b_c/x*y*z']);
    assert.deepEqual(one('*https://tyrescart.ae/offers*'), ['<bold:https://tyrescart.ae/offers>']);
    assert.deepEqual(one('_see www.tyrescart.ae_'), ['<italic:see www.tyrescart.ae>']);
  });
  test('emojis and other scripts are kept and can be formatted', () => {
    assert.deepEqual(one('😀*great*👍 *مرحبا* _नमस्ते_'), ['😀<bold:great>👍 <bold:مرحبا> <italic:नमस्ते>']);
  });
  test('the original text is fully there: every character is shown or is a marker that was used', () => {
    const text = 'Hello *Bina* 👋\n\n_Tyre_ ~price~: `AED 400`\nhttps://x.ae/a_b';
    const lines = (parseFormatting(text)[0] as Extract<Block, { kind: 'paragraph' }>).lines.map(flat);
    assert.deepEqual(lines, ['Hello <bold:Bina> 👋', '', '<italic:Tyre> <strike:price>: <code:AED 400>', 'https://x.ae/a_b']);
  });
  test('empty text has nothing; plain text is one line', () => {
    assert.deepEqual(parseFormatting(''), []);
    assert.deepEqual(one('just text'), ['just text']);
  });
  test('deep or very long input stays quick and safe', () => {
    const t0 = Date.now();
    parseFormatting('*_~'.repeat(500) + 'x' + '~_*'.repeat(500));
    parseFormatting(('*a ' + '_b '.repeat(50) + '\n').repeat(80));
    assert.ok(Date.now() - t0 < 500);
  });
});

describe('parseFormatting: lists and quotes', () => {
  test('bulleted lists ("- " or "* "), with formatting inside', () => {
    const b = parseFormatting('We have:\n- *Michelin*\n* Bridgestone\nCall us');
    assert.deepEqual(b.map((x) => x.kind), ['paragraph', 'bullet', 'paragraph']);
    assert.deepEqual((b[1] as Extract<Block, { kind: 'bullet' }>).items.map(flat), ['<bold:Michelin>', 'Bridgestone']);
  });
  test('numbered lists keep the numbers as typed', () => {
    const b = parseFormatting('1. Choose size\n2. _Pay_\n5. Fitting');
    assert.equal(b[0].kind, 'numbered');
    assert.deepEqual((b[0] as Extract<Block, { kind: 'numbered' }>).items.map((i) => [i.number, flat(i.content)]), [
      [1, 'Choose size'],
      [2, '<italic:Pay>'],
      [5, 'Fitting'],
    ]);
  });
  test('quotes ("> ")', () => {
    const b = parseFormatting('> Do you fit tyres?\n> *Today*\nYes we do');
    assert.deepEqual(b.map((x) => x.kind), ['quote', 'paragraph']);
    assert.deepEqual((b[0] as Extract<Block, { kind: 'quote' }>).lines.map(flat), ['Do you fit tyres?', '<bold:Today>']);
  });
  test('not lists: no space after the sign, nothing after it, or a bold line', () => {
    assert.deepEqual(parseFormatting('-5 degrees\n*bold line*\n1.5 litres\n- ').map((x) => x.kind), ['paragraph']);
  });
});

describe('toggleInline (toolbar and shortcuts)', () => {
  test('wraps the selection and keeps it selected', () => {
    assert.deepEqual(toggleInline('Hello Bina', 6, 10, 'bold'), { text: 'Hello *Bina*', start: 6, end: 12 });
    assert.deepEqual(toggleInline('price', 0, 5, 'strike'), { text: '~price~', start: 0, end: 7 });
    assert.deepEqual(toggleInline('size', 0, 4, 'mono'), { text: '```size```', start: 0, end: 10 });
    assert.deepEqual(toggleInline('code', 0, 4, 'code'), { text: '`code`', start: 0, end: 6 });
  });
  test('spaces at the edges stay outside the markers', () => {
    assert.equal(toggleInline('say hello there', 3, 10, 'italic').text, 'say _hello_ there');
  });
  test('each line is wrapped on its own (monospace wraps the whole block)', () => {
    assert.equal(toggleInline('one\ntwo', 0, 7, 'bold').text, '*one*\n*two*');
    assert.equal(toggleInline('one\n\ntwo', 0, 8, 'bold').text, '*one*\n\n*two*');
    assert.equal(toggleInline('one\ntwo', 0, 7, 'mono').text, '```one\ntwo```');
  });
  test('toggles off: markers just outside the selection, or included in it', () => {
    assert.deepEqual(toggleInline('Hello *Bina*', 7, 11, 'bold'), { text: 'Hello Bina', start: 6, end: 10 });
    assert.deepEqual(toggleInline('Hello *Bina*', 6, 12, 'bold'), { text: 'Hello Bina', start: 6, end: 10 });
  });
  test('combines with other styles', () => {
    const bold = toggleInline('great', 0, 5, 'bold');
    assert.equal(toggleInline(bold.text, bold.start, bold.end, 'italic').text, '_*great*_');
  });
  test('no selection: a pair of markers with the cursor inside; again removes the empty pair', () => {
    assert.deepEqual(toggleInline('Hi ', 3, 3, 'bold'), { text: 'Hi **', start: 4, end: 4 });
    assert.deepEqual(toggleInline('Hi **', 4, 4, 'bold'), { text: 'Hi ', start: 3, end: 3 });
  });
  test('emojis are kept whole', () => {
    assert.equal(toggleInline('Deal 🔥 today', 5, 7, 'bold').text, 'Deal *🔥* today');
  });
});

describe('toggleLines (lists and quotes)', () => {
  test('every selected line becomes an item; numbers go 1, 2, 3', () => {
    assert.equal(toggleLines('a\nb\nc', 0, 5, 'bullet').text, '- a\n- b\n- c');
    assert.equal(toggleLines('a\nb\nc', 0, 5, 'numbered').text, '1. a\n2. b\n3. c');
    assert.equal(toggleLines('a\nb', 0, 3, 'quote').text, '> a\n> b');
  });
  test('only the lines the selection touches; empty lines in between are left alone', () => {
    assert.equal(toggleLines('top\na\n\nb\nend', 5, 8, 'bullet').text, 'top\n- a\n\n- b\nend');
  });
  test('again turns them back into plain lines; switching list kind renumbers', () => {
    assert.equal(toggleLines('- a\n- b', 0, 7, 'bullet').text, 'a\nb');
    assert.equal(toggleLines('- a\n* b', 0, 7, 'numbered').text, '1. a\n2. b');
    assert.equal(toggleLines('> a', 0, 3, 'quote').text, 'a');
  });
  test('a quote keeps a list inside it', () => {
    assert.equal(toggleLines('- a', 0, 3, 'quote').text, '> - a');
  });
  test('cursor only: its line, the cursor stays on its text', () => {
    assert.deepEqual(toggleLines('first\nsecond', 9, 9, 'bullet'), { text: 'first\n- second', start: 11, end: 11 });
    assert.deepEqual(toggleLines('', 0, 0, 'numbered'), { text: '1. ', start: 3, end: 3 });
    assert.deepEqual(toggleLines('- item', 0, 0, 'bullet'), { text: 'item', start: 0, end: 0 });
  });
  test('a selection that ends at a line break doesn’t take the next line', () => {
    assert.equal(toggleLines('a\nb\nc', 0, 2, 'bullet').text, '- a\nb\nc');
  });
});

test('shortcutStyle: WhatsApp Desktop shortcuts, Ctrl or ⌘', () => {
  const k = (key: string, o: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
    shortcutStyle({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });
  assert.equal(k('b', { ctrlKey: true }), 'bold');
  assert.equal(k('i', { metaKey: true }), 'italic');
  assert.equal(k('X', { ctrlKey: true, shiftKey: true }), 'strike');
  assert.equal(k('M', { metaKey: true, shiftKey: true }), 'mono');
  assert.equal(k('b'), null);
  assert.equal(k('x', { ctrlKey: true }), null); // Ctrl+X is still cut
  assert.equal(k('b', { ctrlKey: true, altKey: true }), null);
});
