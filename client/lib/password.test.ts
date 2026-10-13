// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_NEW_USER_PASSWORD, passwordProblem, passwordsProblem, suggestPassword } from './password';

describe('password rule (create/edit user form)', () => {
  test('8-72 characters with a letter and a number', () => {
    assert.equal(passwordProblem('Secret123'), null);
    assert.equal(passwordProblem('a1234567'), null);
    assert.equal(passwordProblem('short1'), 'Password must be at least 8 characters');
    assert.equal(passwordProblem('onlyletters'), 'Password must include at least one letter and one number');
    assert.equal(passwordProblem('12345678'), 'Password must include at least one letter and one number');
    assert.equal(passwordProblem('a1'.repeat(37)), 'Password is too long');
    assert.equal(passwordProblem(''), 'Password must be at least 8 characters');
  });

  test('confirm must match, checked after the strength rule', () => {
    assert.equal(passwordsProblem('Secret123', 'Secret123'), null);
    assert.equal(passwordsProblem('Secret123', 'Secret124'), 'Passwords do not match');
    assert.equal(passwordsProblem('Secret123', ''), 'Passwords do not match');
    assert.equal(passwordsProblem('weak', 'weak'), 'Password must be at least 8 characters'); // strength first
  });
});

describe('suggested password', () => {
  test('always satisfies the rule and is 12 readable characters', () => {
    for (let i = 0; i < 200; i++) {
      const p = suggestPassword();
      assert.equal(passwordProblem(p), null, p);
      assert.equal(p.length, 12);
      assert.ok(!/[0OIl1]/.test(p), p); // no look-alike characters
    }
  });

  test('re-rolls a draw that would break the rule', () => {
    let calls = 0;
    const p = suggestPassword((n) => (calls++ < 12 ? 0 : (calls % 2 ? 0 : 50) % n)); // first draw: 12x "a" (no digit), then letters and digits
    assert.equal(passwordProblem(p), null);
  });
});

describe('default password for new users', () => {
  test('is pre-filled and satisfies the rule', () => {
    assert.equal(DEFAULT_NEW_USER_PASSWORD, 'Tyres@123');
    assert.equal(passwordProblem(DEFAULT_NEW_USER_PASSWORD), null);
  });
});
