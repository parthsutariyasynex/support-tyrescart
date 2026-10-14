// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { findMessageMatches, highlightSegments } from './messageSearch';

describe('Search in conversation', () => {
  const msgs = [
    { id: 'm1', body: 'Do you have Michelin 205/55?', deletedAt: null },
    { id: 'm2', body: 'Yes, Michelin and Pirelli in stock', deletedAt: null },
    { id: 'm3', body: 'michelin price?', deletedAt: '2026-10-14T10:00:00.000Z' },
    { id: 'm4', body: 'Sending the quote now', deletedAt: null },
  ];
  test('matches are case-insensitive substrings over loaded, non-deleted messages, oldest first', () => {
    assert.deepEqual(findMessageMatches(msgs, 'michelin'), ['m1', 'm2']);
    assert.deepEqual(findMessageMatches(msgs, 'MICHELIN '), ['m1', 'm2']);
    assert.deepEqual(findMessageMatches(msgs, '205/55'), ['m1']);
    assert.deepEqual(findMessageMatches(msgs, 'quote'), ['m4']);
    assert.deepEqual(findMessageMatches(msgs, 'nothing'), []);
    assert.deepEqual(findMessageMatches(msgs, ''), []);
    assert.deepEqual(findMessageMatches(msgs, '   '), []);
  });
  test('highlighting splits the text around every occurrence, keeping the original casing', () => {
    assert.deepEqual(highlightSegments('Yes, Michelin and michelin', 'michelin'), [
      { text: 'Yes, ', match: false },
      { text: 'Michelin', match: true },
      { text: ' and ', match: false },
      { text: 'michelin', match: true },
    ]);
    assert.deepEqual(highlightSegments('abc', ''), [{ text: 'abc', match: false }]);
    assert.deepEqual(highlightSegments('abc', 'zzz'), [{ text: 'abc', match: false }]);
    assert.deepEqual(highlightSegments('', 'a'), [{ text: '', match: false }]);
    assert.deepEqual(highlightSegments('aaa', 'a'), [{ text: 'a', match: true }, { text: 'a', match: true }, { text: 'a', match: true }]);
  });
});
