import assert from 'node:assert/strict';
import { test } from 'node:test';
import { avatarProblem } from './avatar';

test('profile picture: JPG, PNG or WebP up to 2 MB', () => {
  assert.equal(avatarProblem({ type: 'image/png', size: 1000 }), '');
  assert.equal(avatarProblem({ type: 'image/webp', size: 2 * 1024 * 1024 }), '');
  assert.equal(avatarProblem({ type: 'image/gif', size: 1000 }), 'Use a JPG, PNG or WebP picture');
  assert.equal(avatarProblem({ type: 'image/jpeg', size: 2 * 1024 * 1024 + 1 }), 'Profile pictures can be up to 2 MB');
  assert.equal(avatarProblem({ type: 'image/jpeg', size: 0 }), 'That file is empty');
});
