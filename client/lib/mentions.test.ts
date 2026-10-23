// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { insertMention, matchMembers, mentionAt, mentionPieces } from './mentions';

describe('@mentions in notes', () => {
  test('@ at the start or after a space opens the list; an email address does not', () => {
    assert.deepEqual(mentionAt('@', 1), { start: 0, query: '' });
    assert.deepEqual(mentionAt('please call @dee', 16), { start: 12, query: 'dee' });
    assert.deepEqual(mentionAt('line one\n@ana', 13), { start: 9, query: 'ana' });
    assert.equal(mentionAt('mail me at a@b.com', 18), null);
    assert.equal(mentionAt('@deep patel ', 12), null); // a finished mention (space typed after it)
    assert.equal(mentionAt('hello', 5), null);
  });
  test('teammates by name (start, then any word) or email', () => {
    const members = [
      { name: 'deep patel', email: 'deep@tyrescart.ae' },
      { name: 'Nikhil Shah', email: 'nikhil@tyrescart.ae' },
      { name: 'patel Parth', email: 'parthsutariya.synex@gmail.com' },
    ];
    assert.deepEqual(matchMembers(members, '').map((m) => m.name), ['deep patel', 'Nikhil Shah', 'patel Parth']);
    assert.deepEqual(matchMembers(members, 'pat').map((m) => m.name), ['patel Parth', 'deep patel']);
    assert.deepEqual(matchMembers(members, 'synex').map((m) => m.name), ['patel Parth']);
    assert.deepEqual(matchMembers(members, 'zzz'), []);
  });
  test('picking one puts "@Name " at the cursor, keeping the rest', () => {
    assert.deepEqual(insertMention('@', { start: 0, query: '' }, 'deep patel'), { text: '@deep patel ', caret: 12 });
    assert.deepEqual(insertMention('please call @dee today', { start: 12, query: 'dee' }, 'deep patel'), { text: 'please call @deep patel today', caret: 24 });
  });
});

test('mentions in a note are found for highlighting (full names, longest first, word start only)', () => {
  const names = ['deep', 'deep patel', 'Nikhil Shah'];
  assert.deepEqual(mentionPieces('@deep patel please call, cc @Nikhil Shah.', names), [
    { text: '@deep patel', mention: true },
    { text: ' please call, cc ', mention: false },
    { text: '@Nikhil Shah', mention: true },
    { text: '.', mention: false },
  ]);
  assert.deepEqual(mentionPieces('mail a@deep.com', names), [{ text: 'mail a@deep.com', mention: false }]);
  assert.deepEqual(mentionPieces('@deepak is new', names), [{ text: '@deepak is new', mention: false }]);
  assert.deepEqual(mentionPieces('no mentions', []), [{ text: 'no mentions', mention: false }]);
});
