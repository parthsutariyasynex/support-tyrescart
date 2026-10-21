import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkSegments } from './links';

const links = (t: string) => linkSegments(t).filter((s) => s.href).map((s) => [s.text, s.href]);

test('finds http(s) and www addresses, drops sentence punctuation', () => {
  assert.deepEqual(links('Order here: https://tyrescart.ae/offers?size=17. Thanks!'), [['https://tyrescart.ae/offers?size=17', 'https://tyrescart.ae/offers?size=17']]);
  assert.deepEqual(links('see www.tyrescart.ae, or (https://example.com/a)'), [
    ['www.tyrescart.ae', 'https://www.tyrescart.ae/'],
    ['https://example.com/a', 'https://example.com/a'],
  ]);
  assert.deepEqual(links('wiki https://en.wikipedia.org/wiki/Tyre_(disambiguation) ok'), [
    ['https://en.wikipedia.org/wiki/Tyre_(disambiguation)', 'https://en.wikipedia.org/wiki/Tyre_(disambiguation)'],
  ]);
});

test('text around links is kept exactly; no links → one plain segment', () => {
  const t = 'Hi! http://a.com and https://b.com/x done';
  assert.equal(linkSegments(t).map((s) => s.text).join(''), t);
  assert.deepEqual(linkSegments('no links here'), [{ text: 'no links here' }]);
  assert.deepEqual(linkSegments(''), [{ text: '' }]);
});

test('never links other schemes', () => {
  assert.deepEqual(links('javascript:alert(1) mailto:a@b.com ftp://x.com'), []);
});
