// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { highlightParts, matchesQuickReply, slashQuery } from './quickReplies';

describe('quick replies helpers', () => {
  test('"/" at the start opens the menu; the rest is the search', () => {
    assert.equal(slashQuery('/'), '');
    assert.equal(slashQuery('/tyrescart'), 'tyrescart');
    assert.equal(slashQuery('/Payment Options'), 'Payment Options');
    assert.equal(slashQuery('hello /tyrescart'), null); // only at the start, like WhatsApp Business
    assert.equal(slashQuery(''), null);
  });

  test('highlights every case-insensitive match and keeps the original text', () => {
    const parts = highlightParts('Welcome to TyresCart.ae, the tyrescart shop', 'TYRESCART');
    assert.deepEqual(parts, [
      { text: 'Welcome to ', match: false },
      { text: 'TyresCart', match: true },
      { text: '.ae, the ', match: false },
      { text: 'tyrescart', match: true },
      { text: ' shop', match: false },
    ]);
    assert.equal(parts.map((p) => p.text).join(''), 'Welcome to TyresCart.ae, the tyrescart shop');
  });

  test('no query, no match, and special characters are treated literally', () => {
    assert.deepEqual(highlightParts('Stockcheck', ''), [{ text: 'Stockcheck', match: false }]);
    assert.deepEqual(highlightParts('Stockcheck', 'xyz'), [{ text: 'Stockcheck', match: false }]);
    assert.deepEqual(highlightParts('AED 150+ (approx.)', '150+ ('), [
      { text: 'AED ', match: false },
      { text: '150+ (', match: true },
      { text: 'approx.)', match: false },
    ]);
  });
});

describe('matchesQuickReply (narrowing while results load)', () => {
  const r = { id: '1', shortcut: 'Hours', description: "We're currently open\nFriday: 09:00", category: 'car_tyres' };
  test('matches shortcut, text or category, case-insensitively; empty search matches everything', () => {
    assert.ok(matchesQuickReply(r, 'hours'));
    assert.ok(matchesQuickReply(r, 'FRIDAY'));
    assert.ok(matchesQuickReply(r, 'car_ty'));
    assert.ok(matchesQuickReply(r, 'car tyres')); // shown as "car tyres"
    assert.ok(matchesQuickReply(r, 'CAR TY'));
    assert.ok(matchesQuickReply(r, '  '));
    assert.ok(!matchesQuickReply(r, 'tyrescart'));
    assert.ok(!matchesQuickReply({ ...r, description: null, category: null }, 'friday'));
  });
});

describe('emojis in quick replies (client)', () => {
  const text = 'Welcome to TyresCart.ae 🇦🇪 — thanks 🤗👨‍🔧';
  test('highlighting never splits an emoji and rebuilds the exact text', () => {
    for (const q of ['tyrescart', '🤗', '🇦🇪', 'thanks 🤗', '👨‍🔧']) {
      const parts = highlightParts(text, q);
      assert.equal(parts.map((p) => p.text).join(''), text);
      for (const p of parts) assert.ok(!/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(p.text), `split surrogate pair for "${q}"`);
    }
    assert.deepEqual(highlightParts(text, '🤗').filter((p) => p.match).map((p) => p.text), ['🤗']);
  });
  test('"/" search with emojis', () => {
    assert.equal(slashQuery('/welcome😊'), 'welcome😊');
    const r = { id: '1', shortcut: 'referring', description: text, category: 'car_tyres' };
    assert.ok(matchesQuickReply(r, '🇦🇪'));
    assert.ok(!matchesQuickReply(r, '😊'));
  });
});
