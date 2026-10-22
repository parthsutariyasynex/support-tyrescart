// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isAssignedTo, isNewLead, matchesSearch, needsAttention } from './inbox';

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

describe('bold rows: unread messages or an assignment you have not opened yet', () => {
  const base = { unread: 0, assignee: { id: 'm1', name: 'Ana', color: '#047857', userId: 'u-ana' }, assigneeOpenedAt: null, status: 'open' as const };
  test('unread customer messages: bold for everyone', () => {
    assert.equal(needsAttention({ ...base, unread: 2, assignee: null }, 'u-ben'), true);
    assert.equal(needsAttention({ ...base, unread: 2 }, null), true);
  });
  test('assigned to you and not opened since: bold for you only, until you open it', () => {
    assert.equal(needsAttention(base, 'u-ana'), true);
    assert.equal(needsAttention(base, 'u-ben'), false);
    assert.equal(needsAttention(base, null), false);
    assert.equal(needsAttention({ ...base, assigneeOpenedAt: '2026-10-14T10:00:00.000Z' }, 'u-ana'), false);
    assert.equal(needsAttention({ ...base, assignee: null }, 'u-ana'), false);
  });
  test('a closed chat is never bold for its assignee (unread still counts)', () => {
    assert.equal(needsAttention({ ...base, status: 'closed' }, 'u-ana'), false);
    assert.equal(needsAttention({ ...base, status: 'closed', unread: 1 }, 'u-ana'), true);
  });
});

describe('search box: name, number, message, label, assignee, status', () => {
  const chat = {
    contact: { id: 'c1', waId: '971501234567', name: 'Riya Sharma' },
    lastMessage: { body: 'Do you have 205/55 R16?', deletedAt: null } as any,
    labels: [{ id: 'l1', name: 'VIP', color: '#000' }, { id: 'l2', name: 'Follow up', color: '#000' }],
    assignee: { id: 'm1', name: 'Nikhil', color: '#047857', userId: 'u1' },
    status: 'open' as const,
    unread: 2,
  };
  test('empty or blank matches everything', () => {
    assert.equal(matchesSearch(chat, ''), true);
    assert.equal(matchesSearch(chat, '   '), true);
  });
  test('customer name and phone digits (with spaces, + or dashes typed), case-insensitive', () => {
    assert.equal(matchesSearch(chat, 'riya'), true);
    assert.equal(matchesSearch(chat, 'SHARMA'), true);
    assert.equal(matchesSearch(chat, '+971 50'), true);
    assert.equal(matchesSearch(chat, '50-123'), true);
    assert.equal(matchesSearch(chat, '99'), false); // too short to be a number search, and not in the name
    assert.equal(matchesSearch(chat, 'priya'), false);
  });
  test('last message text, label names and the assignee', () => {
    assert.equal(matchesSearch(chat, '205/55'), true);
    assert.equal(matchesSearch(chat, 'r16'), true);
    assert.equal(matchesSearch(chat, 'vip'), true);
    assert.equal(matchesSearch(chat, 'follow'), true);
    assert.equal(matchesSearch(chat, 'nikhil'), true);
    assert.equal(matchesSearch(chat, 'nikhil'.toUpperCase()), true);
    assert.equal(matchesSearch({ ...chat, assignee: null }, 'nikhil'), false);
    assert.equal(matchesSearch({ ...chat, lastMessage: { ...chat.lastMessage, deletedAt: '2026-10-14T10:00:00.000Z' } }, '205/55'), false); // deleted text is gone
  });
  test('status words: open / closed / unread / assigned / unassigned', () => {
    assert.equal(matchesSearch(chat, 'open'), true);
    assert.equal(matchesSearch(chat, 'closed'), false);
    assert.equal(matchesSearch({ ...chat, status: 'closed' }, 'closed'), true);
    assert.equal(matchesSearch(chat, 'unread'), true);
    assert.equal(matchesSearch({ ...chat, unread: 0 }, 'unread'), false);
    assert.equal(matchesSearch(chat, 'assigned'), true);
    assert.equal(matchesSearch(chat, 'unassigned'), false);
    assert.equal(matchesSearch({ ...chat, assignee: null }, 'unassigned'), true);
  });
});

describe('New Leads: open chats nobody holds', () => {
  const ana = { id: 'a1', name: 'Ana', color: '#047857', userId: 'u1' };
  test('open and unassigned (also a chat unassigned again)', () => {
    assert.equal(isNewLead({ assignee: null, status: 'open' }), true);
  });
  test('not while someone holds it; not closed or snoozed', () => {
    assert.equal(isNewLead({ assignee: ana, status: 'open' }), false);
    assert.equal(isNewLead({ assignee: null, status: 'closed' }), false);
    assert.equal(isNewLead({ assignee: null, status: 'snoozed' }), false);
  });
});
