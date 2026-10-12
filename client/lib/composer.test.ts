// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { enterAction } from './composer';

describe('message box keys', () => {
  test('Enter sends, Shift+Enter adds a new line', () => {
    assert.equal(enterAction({ key: 'Enter', shiftKey: false }), 'send');
    assert.equal(enterAction({ key: 'Enter', shiftKey: true }), 'newline');
  });
  test('nothing while an input method is composing, and other keys are left alone', () => {
    assert.equal(enterAction({ key: 'Enter', shiftKey: false, isComposing: true }), null);
    assert.equal(enterAction({ key: 'Enter', shiftKey: true, isComposing: true }), null);
    for (const key of ['a', 'Tab', 'Escape', 'ArrowDown', ' ']) assert.equal(enterAction({ key, shiftKey: false }), null);
  });
});
