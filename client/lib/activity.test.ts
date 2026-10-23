import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type Activity, activityText, bellFeed, inBell } from './activity';

const base: Activity = { id: 'a', type: 'assigned', conversationId: 'c', actorId: null, actorName: null, contactName: 'Amir', data: null, createdAt: '' };

test('who assigned a chat: a person, you, the automation, or someone', () => {
  const data = (d: object) => JSON.stringify({ assignee: 'Satya Agent', assigneeUserId: 'u2', ...d });
  assert.match(activityText({ ...base, actorId: 'u1', actorName: 'Parth', data: data({}) }, 'u9', 'chat'), /^Parth assigned this chat to Satya Agent/);
  assert.match(activityText({ ...base, actorId: 'u1', actorName: 'Parth', data: data({}) }, 'u1', 'chat'), /^You assigned/);
  assert.match(activityText({ ...base, data: data({ by: 'Simple automations' }) }, 'u9', 'chat'), /^Simple automations assigned this chat to Satya Agent/);
  assert.match(activityText({ ...base, data: data({}) }, 'u9', 'chat'), /^Someone assigned/);
});

describe('bell: chat activity, not customer messages', () => {
  const a = (id: string, type: string, createdAt: string) => ({ id, type, conversationId: 'c1', actorId: null, actorName: null, contactName: 'Alice', data: null, createdAt });
  const items = [
    a('1', 'message_received', '2026-10-22T10:05:00Z'),
    a('2', 'assigned', '2026-10-22T10:04:00Z'),
    a('3', 'message_received', '2026-10-22T10:03:00Z'),
    a('4', 'label_added', '2026-10-22T09:00:00Z'),
  ];
  test('customer messages are left out (they come as desktop notifications)', () => {
    assert.equal(inBell({ type: 'message_received' }), false);
    assert.equal(inBell({ type: 'assigned' }), true);
    assert.deepEqual(bellFeed({ items, seenAt: null }).items.map((x) => x.id), ['2', '4']);
  });
  test('the badge counts only what the bell lists, newer than your last look', () => {
    assert.equal(bellFeed({ items, seenAt: null }).unseen, 2);
    assert.equal(bellFeed({ items, seenAt: '2026-10-22T09:30:00Z' }).unseen, 1); // the assignment, not the two messages
    assert.equal(bellFeed({ items, seenAt: '2026-10-22T11:00:00Z' }).unseen, 0);
  });
  test('at most 30 listed', () => {
    const many = Array.from({ length: 80 }, (_, i) => a(String(i), 'assigned', '2026-10-22T10:00:00Z'));
    assert.equal(bellFeed({ items: many, seenAt: null }).items.length, 30);
  });
});

test('a mention in the bell: who, which chat and the note', () => {
  const a = { id: 'x', type: 'note_mention', conversationId: 'c', actorId: 'u1', actorName: 'deep patel', contactName: 'Parth patel', data: JSON.stringify({ remarkId: 'r', mentionedUserId: 'u2', text: '@Nikhil Shah please call' }), createdAt: '2026-10-23T10:00:00.000Z' };
  assert.equal(activityText(a as never, 'u2', 'bell'), 'deep patel mentioned you in a note on the chat with Parth patel: @Nikhil Shah please call');
  assert.equal(inBell(a as never), true);
});
