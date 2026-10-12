// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ROLE_STYLES, assignableMembers, roleStyle } from './roles';

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
