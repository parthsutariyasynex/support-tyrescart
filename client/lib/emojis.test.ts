import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { insertAt } from './emojis';

describe('emoji insertion at the cursor', () => {
  test('insert at the cursor, replacing a selection', () => {
    assert.deepEqual(insertAt('Hello world', '👋', 5), { text: 'Hello👋 world', cursor: 7 });
    assert.deepEqual(insertAt('Hello world', '🙂', 6, 11), { text: 'Hello 🙂', cursor: 8 });
    assert.deepEqual(insertAt('', '🔥', 0), { text: '🔥', cursor: 2 });
    assert.deepEqual(insertAt('ab', 'x', 99), { text: 'abx', cursor: 3 });
  });
  test('emojis of several characters (skin tones, flags, families) go in whole, the cursor right after them', () => {
    for (const emoji of ['👍🏽', '🇦🇪', '👨‍👩‍👧', '❤️']) {
      const r = insertAt('Tyres ready', emoji, 5);
      assert.equal(r.text, `Tyres${emoji} ready`);
      assert.equal(r.text.slice(0, r.cursor), `Tyres${emoji}`); // nothing split, nothing lost
    }
  });
  test('several in a row keep their order; the text around stays as it was', () => {
    let t = { text: 'Thanks !', cursor: 7 };
    for (const e of ['🙏', '👍🏽']) t = insertAt(t.text, e, t.cursor);
    assert.equal(t.text, 'Thanks 🙏👍🏽!');
  });
});
