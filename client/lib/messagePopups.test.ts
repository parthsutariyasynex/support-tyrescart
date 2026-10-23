// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type MessagePopup, POPUP_MAX, addPopup, alertsYou } from './messagePopups';

const p = (conversationId: string, body = 'hi'): MessagePopup => ({ id: `${conversationId}:${body}`, conversationId, title: conversationId, body, tag: `message-${conversationId}` });

describe('in-app message pop-ups', () => {
  test('newest first; a newer message from the same chat replaces its pop-up', () => {
    let list = addPopup([], p('a'));
    list = addPopup(list, p('b'));
    list = addPopup(list, p('a', 'again'));
    assert.deepEqual(list.map((x) => `${x.conversationId}:${x.body}`), ['a:again', 'b:hi']);
  });
  test(`at most ${POPUP_MAX} at once, the oldest goes`, () => {
    let list: MessagePopup[] = [];
    for (const c of ['a', 'b', 'c', 'd']) list = addPopup(list, p(c));
    assert.deepEqual(list.map((x) => x.conversationId), ['d', 'c', 'b']);
  });
});

describe('who is alerted for a customer message', () => {
  const agent = { userId: 'u1', isAdmin: false };
  const chat = { assigneeUserId: 'u2', isCollaborator: false, unassigned: false };
  test("owners and admins: every chat", () => assert.equal(alertsYou(chat, { userId: 'u1', isAdmin: true }), true));
  test('others: unassigned chats, their own, and chats they collaborate on; not a teammate’s chat', () => {
    assert.equal(alertsYou(chat, agent), false);
    assert.equal(alertsYou({ ...chat, assigneeUserId: null, unassigned: true }, agent), true);
    assert.equal(alertsYou({ ...chat, assigneeUserId: 'u1' }, agent), true);
    assert.equal(alertsYou({ ...chat, isCollaborator: true }, agent), true);
  });
});
