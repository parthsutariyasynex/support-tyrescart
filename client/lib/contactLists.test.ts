import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { searchLists, upsertList } from './contactLists';

const lists = [{ id: '1', name: 'Leads' }, { id: '2', name: 'VIP' }, { id: '3', name: 'VIP Fleet' }];

describe('contact list helpers', () => {
  test('search by name; create offered only for a new name', () => {
    assert.deepEqual(searchLists(lists, '').shown.map((l) => l.name), ['Leads', 'VIP', 'VIP Fleet']);
    assert.equal(searchLists(lists, '').canCreate, false);
    assert.deepEqual(searchLists(lists, 'vip').shown.map((l) => l.name), ['VIP', 'VIP Fleet']);
    assert.equal(searchLists(lists, 'vip').canCreate, false); // "VIP" exists (case-insensitive)
    const r = searchLists(lists, '  Welcome  ');
    assert.deepEqual([r.shown.length, r.canCreate, r.name], [0, true, 'Welcome']);
    assert.equal(searchLists(lists, 'x'.repeat(101)).canCreate, false);
  });
  test('upsert keeps A to Z and replaces by id', () => {
    assert.deepEqual(upsertList(lists, { id: '4', name: 'Campaign' }).map((l) => l.name), ['Campaign', 'Leads', 'VIP', 'VIP Fleet']);
    assert.deepEqual(upsertList(lists, { id: '1', name: 'Zed' }).map((l) => l.name), ['VIP', 'VIP Fleet', 'Zed']);
  });
});
