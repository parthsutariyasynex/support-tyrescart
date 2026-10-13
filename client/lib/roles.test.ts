// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ROLE_STYLES, assignableMembers, isAdminRole, otherAssigneesToList, roleStyle, showsAssignCheckboxes } from './roles';

describe('Assign menu people and role badges', () => {
  test('the owner, Supervisors and Agents are listed (other Admins are left out), by name', () => {
    const members = [
      { id: '1', name: 'Zoya', email: 'z@example.com', role: 'agent' },
      { id: '2', name: 'Owner', email: 'o@example.com', role: 'owner' },
      { id: '3', name: 'Adam', email: 'a@example.com', role: 'admin' },
      { id: '4', name: 'Sana', email: 's@example.com', role: 'supervisor' },
      { id: '5', name: 'Arun', email: 'ar@example.com', role: 'agent' },
      { id: '6', name: 'Ghost', email: 'g@example.com', role: 'something-else' },
    ];
    assert.deepEqual(assignableMembers(members).map((m) => [m.name, m.role]), [['Arun', 'agent'], ['Owner', 'owner'], ['Sana', 'supervisor'], ['Zoya', 'agent']]);
    assert.deepEqual(assignableMembers([]), []);
    assert.equal(assignableMembers(members)[0].email, 'ar@example.com'); // keeps the email for the row
  });

  test('role colours: Admin purple, Supervisor blue, Agent green; owners show as Admin', () => {
    assert.deepEqual(ROLE_STYLES.admin, { label: 'Admin', color: '#6D28D9' });
    assert.deepEqual(ROLE_STYLES.supervisor, { label: 'Supervisor', color: '#1D4ED8' });
    assert.deepEqual(ROLE_STYLES.agent, { label: 'Agent', color: '#047857' });
    assert.equal(roleStyle('owner'), ROLE_STYLES.admin);
    assert.equal(roleStyle('admin'), ROLE_STYLES.admin);
    assert.equal(roleStyle('supervisor'), ROLE_STYLES.supervisor);
    assert.equal(roleStyle('agent'), ROLE_STYLES.agent);
    assert.equal(roleStyle(undefined), ROLE_STYLES.agent); // unknown -> least access
  });
});

describe('Assign list checkboxes: owners and admins only', () => {
  const perms = (role: string, canManageAssignments: boolean) => ({ userId: 'u1', role, canManageLabels: true, canManageAssignments });

  test('shown only when the server says the person may manage assignments (owners and admins)', () => {
    assert.equal(showsAssignCheckboxes(perms('owner', true)), true);
    assert.equal(showsAssignCheckboxes(perms('admin', true)), true);
    assert.equal(showsAssignCheckboxes(perms('supervisor', false)), false);
    assert.equal(showsAssignCheckboxes(perms('agent', false)), false);
  });

  test('never decided by the role name alone: a supervisor or agent flag stays hidden, and vice versa', () => {
    // The server flag is the only input; a label grant or a role string can't turn the checkboxes on
    assert.equal(showsAssignCheckboxes(perms('supervisor', true as boolean)), true); // only if the server ever said so
    assert.equal(showsAssignCheckboxes(perms('admin', false)), false);
    assert.equal(showsAssignCheckboxes({ canManageAssignments: 'yes' as unknown as boolean }), false); // strict boolean
  });

  test('hidden while permissions are still loading or missing (New Leads, My Chats and Inbox share this)', () => {
    assert.equal(showsAssignCheckboxes(null), false);
    assert.equal(showsAssignCheckboxes(undefined), false);
  });
});

describe('Teams tab: owners and admins only', () => {
  test('the nav entry and the page gate on the admin roles; supervisors, agents and unknown roles are out', () => {
    assert.equal(isAdminRole('owner'), true);
    assert.equal(isAdminRole('admin'), true);
    assert.equal(isAdminRole('supervisor'), false);
    assert.equal(isAdminRole('agent'), false);
    assert.equal(isAdminRole(undefined), false);
    assert.equal(isAdminRole(''), false);
  });
});

describe('Assign dropdown: stale assignee names', () => {
  const members = [{ id: 'u-ana' }, { id: 'u-ben' }];
  const assignees = [
    { id: 'a1', name: 'Ana', userId: 'u-ana', conversationCount: 3 }, // a listed member: shown as a person, not here
    { id: 'a2', name: 'deep', userId: null, conversationCount: 0 }, // removed member, nothing assigned: hidden
    { id: 'a3', name: 'Night shift', userId: null, conversationCount: 2 }, // name-only, still holds chats: listed
    { id: 'a4', name: 'Gone', userId: 'u-removed', conversationCount: 1 }, // linked to someone no longer a member: listed while it holds chats
    { id: 'a5', name: 'Gone too', userId: 'u-removed-2', conversationCount: 0 }, // ...and hidden once it holds none
  ];

  test('only names without a current member behind them, and only while they still hold chats', () => {
    assert.deepEqual(otherAssigneesToList(assignees, members).map((a) => a.name), ['Night shift', 'Gone']);
  });

  test('nothing stale: an empty list, so the dropdown is just the team', () => {
    assert.deepEqual(otherAssigneesToList(assignees.slice(0, 2), members), []);
    assert.deepEqual(otherAssigneesToList([], members), []);
  });

  test('a member whose assignee holds chats is never duplicated under the stale names', () => {
    assert.deepEqual(otherAssigneesToList([assignees[0]], members), []);
    assert.deepEqual(otherAssigneesToList([assignees[0]], []).map((a) => a.name), ['Ana']); // members not loaded yet: fall back to the name
  });
});
