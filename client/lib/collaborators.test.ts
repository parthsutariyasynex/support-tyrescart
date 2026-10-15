// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { addableMembers } from './collaborators';

describe('collaborators panel: team members you can add', () => {
  const members = [
    { id: 'u1', name: 'Dev Kumar', email: 'devendra.2025@gmail.com' },
    { id: 'u2', name: 'Alice Patel', email: 'alice.kachiya@gmail.com' },
    { id: 'u3', name: 'Ben', email: 'ben@example.com' },
  ];
  test('existing collaborators are left out; sorted by name', () => {
    assert.deepEqual(addableMembers(members, [{ id: 'u3' }], '').map((m) => m.name), ['Alice Patel', 'Dev Kumar']);
  });
  test('search by name or email, case-insensitive', () => {
    assert.deepEqual(addableMembers(members, [], 'kachiya').map((m) => m.id), ['u2']);
    assert.deepEqual(addableMembers(members, [], 'DEV').map((m) => m.id), ['u1']);
    assert.deepEqual(addableMembers(members, [], 'zzz'), []);
  });
});
