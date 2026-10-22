import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { collaboratorRemovedByYouText, pinText, removedAsCollaboratorText, labelToastText, addedAsCollaboratorText, assignedToYouText, assignmentChangedText, clearToast, currentToast, isDuplicateToast, newChatText, reminderText, removedFromYouText, resetToasts, showToast, templateStatusText } from './toasts';

const base = { conversationId: 'c1', actorId: 'u-parth', actorName: 'Parth', contactName: 'Riya', previous: null };

describe('toast store', () => {
  beforeEach(resetToasts);
  test('shows one toast; the same key within 5 seconds is a duplicate; later or different keys show', () => {
    assert.equal(showToast('k', 'c1', 'hello', '', 1000), true);
    assert.equal(currentToast()?.message, 'hello');
    assert.equal(showToast('k', 'c1', 'hello', '', 3000), false);
    assert.equal(showToast('k', 'c1', 'hello', '', 7000), true);
    assert.equal(showToast('other', 'c2', 'bye', '', 7001), true);
    assert.equal(currentToast()?.conversationId, 'c2');
    clearToast();
    assert.equal(currentToast(), null);
  });
  test('isDuplicateToast', () => {
    assert.equal(isDuplicateToast(null, 'a', 0), false);
    assert.equal(isDuplicateToast({ key: 'a', at: 0 }, 'a', 4999), true);
    assert.equal(isDuplicateToast({ key: 'a', at: 0 }, 'a', 5000), false);
    assert.equal(isDuplicateToast({ key: 'a', at: 0 }, 'b', 1), false);
  });
});

describe('toast texts', () => {
  test('assigned to you / removed / changed', () => {
    const e = { ...base, assignee: { id: 'm-n', userId: 'u-n', name: 'Nikhil' } };
    assert.equal(assignedToYouText(e).message, 'This chat has been assigned to you and is waiting for your attention.');
    assert.equal(assignedToYouText(e).detail, 'Riya · by Parth');
    assert.equal(removedFromYouText(e).message, 'Parth reassigned this chat to Nikhil.');
    assert.equal(removedFromYouText({ ...e, assignee: null }).message, 'Parth unassigned you from this chat.');
    assert.equal(removedFromYouText({ ...e, assignee: { id: 'm-p', userId: 'u-parth', name: 'Parth' } }).message, 'Parth took this chat from you.');
    assert.equal(assignmentChangedText(e).message, 'Parth assigned this chat to Nikhil.');
    assert.equal(assignmentChangedText({ ...e, previous: 'Alice' }).message, 'Parth reassigned this chat from Alice to Nikhil.');
    assert.equal(assignmentChangedText({ ...e, assignee: null, previous: 'Alice' }).message, 'Parth unassigned Alice from this chat.');
  });
  test('label added / removed / deleted', () => {
    assert.deepEqual([labelToastText('added', 'VIP', 'Riya').message, labelToastText('added', 'VIP', 'Riya').detail], ['Label "VIP" added to this chat.', 'Riya']);
    assert.equal(labelToastText('removed', 'VIP', 'Riya').message, 'Label "VIP" removed from this chat.');
    assert.equal(labelToastText('deleted', 'VIP').message, 'Label "VIP" deleted from all chats.');
    assert.equal(labelToastText('deleted', 'VIP').detail, '');
  });
  test('collaborator removed / pin', () => {
    assert.equal(removedAsCollaboratorText({ conversationId: 'c', actorName: 'Parth', contactName: 'Riya' }).message, 'Parth removed you as a collaborator from this chat.');
    assert.equal(collaboratorRemovedByYouText('Hemi', false, 'Riya').message, 'Hemi removed as a collaborator from this chat.');
    assert.equal(collaboratorRemovedByYouText('Me', true).message, 'You removed yourself as a collaborator from this chat.');
    assert.equal(pinText(true, 'Riya').message, 'Chat pinned to the top of your list.');
    assert.equal(pinText(false).message, 'Chat unpinned.');
  });
  test('added as collaborator', () => {
    assert.equal(addedAsCollaboratorText({ conversationId: 'c1', actorName: 'Parth', contactName: 'Riya' }).message, 'Parth added you as a collaborator on this chat.');
  });
  test('new chat: generic, name only', () => {
    const t = newChatText({ conversationId: 'c9', contactName: '+971500000001' });
    assert.equal(t.message, 'New chat received. It is waiting in New Leads.');
    assert.equal(t.detail, '+971500000001');
  });
  test('reminders: assigned, unassigned, both', () => {
    assert.equal(reminderText({ at: 't', chats: [{ conversationId: 'a', contactName: 'A', kind: 'assigned' }] }).message, 'Reminder: 1 chat assigned to you still needs attention.');
    assert.equal(reminderText({ at: 't', chats: [{ conversationId: 'a', contactName: 'A', kind: 'unassigned' }, { conversationId: 'b', contactName: 'B', kind: 'unassigned' }] }).message, 'Reminder: 2 new chats are still unassigned and unread.');
    const both = reminderText({ at: 't', chats: [{ conversationId: 'a', contactName: 'A', kind: 'assigned' }, { conversationId: 'b', contactName: 'B', kind: 'unassigned' }] });
    assert.equal(both.message, 'Reminder: 1 chat assigned to you still needs attention; 1 new chat is still unassigned and unread.');
    assert.equal(both.detail, 'A, B');
  });
});

test('follow-up template decided at Meta: approved, rejected (with the reason), anything else', () => {
  const e = { name: 'follow_up_inquiry', language: 'en', category: 'UTILITY', rejectedReason: null };
  assert.deepEqual(templateStatusText({ ...e, status: 'APPROVED' }), {
    key: 'tpl:follow_up_inquiry:en:APPROVED',
    message: 'Your follow-up template was approved by Meta. Follow-ups after 24 hours use it now.',
    detail: 'follow_up_inquiry (en)',
  });
  assert.equal(templateStatusText({ ...e, status: 'REJECTED', rejectedReason: 'INVALID_FORMAT' }).message, 'Meta rejected your follow-up template: invalid format. Edit it in Message templates.');
  assert.equal(templateStatusText({ ...e, status: 'REJECTED' }).message, 'Meta rejected your follow-up template. Edit it in Message templates.');
  assert.equal(templateStatusText({ ...e, status: 'PAUSED' }).message, 'Meta set your follow-up template to paused.');
});
