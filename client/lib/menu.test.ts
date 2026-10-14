// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { menuItemMatches } from './menu';

describe('Search menu: filters the sidebar items in place', () => {
  const items = ['Inbox', 'New Leads', 'My Chats', 'Teams', 'Reports'];
  const shown = (q: string) => items.filter((l) => menuItemMatches(q, l));

  test('empty or blank shows every item', () => {
    assert.deepEqual(shown(''), items);
    assert.deepEqual(shown('   '), items);
  });

  test('substring of the name, case and spacing do not matter', () => {
    assert.deepEqual(shown('inb'), ['Inbox']);
    assert.deepEqual(shown('LEADS'), ['New Leads']);
    assert.deepEqual(shown('  my  chats '), ['My Chats']);
    assert.deepEqual(shown('e'), ['New Leads', 'Teams', 'Reports']);
    assert.deepEqual(shown('zzz'), []);
  });
});
