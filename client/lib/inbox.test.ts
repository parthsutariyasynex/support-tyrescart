// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isAssignedTo } from './inbox';

describe('My Chats: is this chat assigned to me?', () => {
  const linked = (userId: string | null) => ({ assignee: { id: 'a1', name: 'Ana', color: '#047857', userId } });
  test("only when the chat's assignee is linked to my login", () => {
    assert.equal(isAssignedTo(linked('u-ana'), 'u-ana'), true);
    assert.equal(isAssignedTo(linked('u-ben'), 'u-ana'), false); // reassigned to someone else
  });
  test('never for unassigned chats or name-only assignees, even with my name', () => {
    assert.equal(isAssignedTo({ assignee: null }, 'u-ana'), false);
    assert.equal(isAssignedTo(linked(null), 'u-ana'), false); // "Ana" but not linked to anyone
  });
  test('nothing before I am known (signed out / still loading)', () => {
    assert.equal(isAssignedTo(linked('u-ana'), null), false);
    assert.equal(isAssignedTo(linked('u-ana'), undefined), false);
    assert.equal(isAssignedTo(linked(null), null), false); // null never equals null here
  });
});
