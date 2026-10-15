// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EMPTY_MENU_FILTERS, activeFilterCount, matchesMenuFilters, toServerFilter, toggle } from './chatFilters';

describe('chat list "Filter by" menu', () => {
  const chat = {
    labels: [{ id: 'l-vip', name: 'VIP', color: '#000' }],
    assignee: { id: 'm-ana', name: 'Ana', color: '#000', userId: 'u-ana' },
    lastMessageAt: new Date('2026-10-10T12:00:00').toISOString(),
  };
  const f = (over: Partial<typeof EMPTY_MENU_FILTERS>) => ({ ...EMPTY_MENU_FILTERS, ...over });

  test('nothing selected matches everything and counts zero', () => {
    assert.equal(matchesMenuFilters(chat, EMPTY_MENU_FILTERS), true);
    assert.equal(activeFilterCount(EMPTY_MENU_FILTERS), 0);
    assert.deepEqual(toServerFilter(EMPTY_MENU_FILTERS), { labelIds: null, assigneeIds: null, from: null, to: null });
  });
  test('labels: any of the chosen', () => {
    assert.equal(matchesMenuFilters(chat, f({ labelIds: ['l-vip'] })), true);
    assert.equal(matchesMenuFilters(chat, f({ labelIds: ['l-other', 'l-vip'] })), true);
    assert.equal(matchesMenuFilters(chat, f({ labelIds: ['l-other'] })), false);
  });
  test('collaborator: any of the chosen assignees, or unassigned', () => {
    assert.equal(matchesMenuFilters(chat, f({ assigneeIds: ['m-ana'] })), true);
    assert.equal(matchesMenuFilters(chat, f({ assigneeIds: ['m-ben'] })), false);
    assert.equal(matchesMenuFilters({ ...chat, assignee: null }, f({ assigneeIds: ['unassigned'] })), true);
    assert.equal(matchesMenuFilters({ ...chat, assignee: null }, f({ assigneeIds: ['m-ana'] })), false);
  });
  test('date range on last activity, whole local days, open ends', () => {
    assert.equal(matchesMenuFilters(chat, f({ from: '2026-10-10', to: '2026-10-10' })), true);
    assert.equal(matchesMenuFilters(chat, f({ from: '2026-10-11' })), false);
    assert.equal(matchesMenuFilters(chat, f({ to: '2026-10-09' })), false);
    assert.equal(matchesMenuFilters(chat, f({ from: '2026-10-01' })), true);
  });
  test('groups combine with AND; count is per group; toggle adds and removes', () => {
    assert.equal(matchesMenuFilters(chat, f({ labelIds: ['l-vip'], assigneeIds: ['m-ben'] })), false);
    assert.equal(activeFilterCount(f({ labelIds: ['a', 'b'], assigneeIds: ['c'], from: '2026-10-01' })), 3);
    assert.deepEqual(toggle(['a'], 'b'), ['a', 'b']);
    assert.deepEqual(toggle(['a', 'b'], 'a'), ['b']);
  });
});
