import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Activity, activityText } from './activity';

const base: Activity = { id: 'a', type: 'assigned', conversationId: 'c', actorId: null, actorName: null, contactName: 'Amir', data: null, createdAt: '' };

test('who assigned a chat: a person, you, the automation, or someone', () => {
  const data = (d: object) => JSON.stringify({ assignee: 'Satya Agent', assigneeUserId: 'u2', ...d });
  assert.match(activityText({ ...base, actorId: 'u1', actorName: 'Parth', data: data({}) }, 'u9', 'chat'), /^Parth assigned this chat to Satya Agent/);
  assert.match(activityText({ ...base, actorId: 'u1', actorName: 'Parth', data: data({}) }, 'u1', 'chat'), /^You assigned/);
  assert.match(activityText({ ...base, data: data({ by: 'Simple automations' }) }, 'u9', 'chat'), /^Simple automations assigned this chat to Satya Agent/);
  assert.match(activityText({ ...base, data: data({}) }, 'u9', 'chat'), /^Someone assigned/);
});
