import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EMOJI_GROUPS, insertAt, pushRecent, searchEmojis } from './emojis';

describe('emoji picker', () => {
  test('groups are filled and every emoji has a name', () => {
    assert.ok(EMOJI_GROUPS.length >= 5);
    for (const g of EMOJI_GROUPS) for (const e of g.emojis) assert.ok(e.e && e.n, `${g.key}: ${JSON.stringify(e)}`);
  });
  test('search by word starts, across groups, no duplicates', () => {
    assert.deepEqual(searchEmojis('thumbs').map((e) => e.e), ['👍', '👎']);
    assert.deepEqual(searchEmojis('thumbs up').map((e) => e.e), ['👍']);
    assert.ok(searchEmojis('tyre').some((e) => e.e === '🛞'));
    assert.equal(searchEmojis('truck').filter((e) => e.e === '🚚').length, 1); // in two groups, shown once
    assert.deepEqual(searchEmojis('   '), []);
    assert.deepEqual(searchEmojis('zzzz'), []);
  });
  test('insert at the cursor, replacing a selection', () => {
    assert.deepEqual(insertAt('Hello world', '👋', 5), { text: 'Hello👋 world', cursor: 7 });
    assert.deepEqual(insertAt('Hello world', '🙂', 6, 11), { text: 'Hello 🙂', cursor: 8 });
    assert.deepEqual(insertAt('', '🔥', 0), { text: '🔥', cursor: 2 });
    assert.deepEqual(insertAt('ab', 'x', 99), { text: 'abx', cursor: 3 });
  });
  test('recent: newest first, unique, capped', () => {
    assert.deepEqual(pushRecent(['😀', '👍'], '👍'), ['👍', '😀']);
    assert.equal(pushRecent(Array.from({ length: 20 }, (_, i) => String(i)), 'x').length, 16);
  });
});
