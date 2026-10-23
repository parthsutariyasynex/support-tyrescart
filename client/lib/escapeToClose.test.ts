// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type EscapeEvent, escapeClosesChat } from './escapeToClose';

const esc = (over: Partial<EscapeEvent> = {}): EscapeEvent => ({
  key: 'Escape', repeat: false, isComposing: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, ...over,
});
const body = { tagName: 'BODY' };

describe('Esc leaves the open chat (WhatsApp style)', () => {
  test('a plain Esc with nothing focused, or on a button / message, leaves the chat', () => {
    assert.equal(escapeClosesChat(esc(), body, false), true);
    assert.equal(escapeClosesChat(esc(), { tagName: 'BUTTON' }, false), true);
    assert.equal(escapeClosesChat(esc(), null, false), true);
  });
  test('the empty message box leaves the chat; with text in it Esc stays', () => {
    assert.equal(escapeClosesChat(esc(), { tagName: 'TEXTAREA', composerEmpty: true }, false), true);
    assert.equal(escapeClosesChat(esc(), { tagName: 'TEXTAREA', composerEmpty: false }, false), false);
  });
  test('typing in any other field: never (search boxes, profile fields, selects, rich text)', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input']) assert.equal(escapeClosesChat(esc(), { tagName }, false), false, tagName);
    assert.equal(escapeClosesChat(esc(), { tagName: 'DIV', isContentEditable: true }, false), false);
  });
  test('an open menu, dropdown or dialog closes first; the chat stays', () => {
    assert.equal(escapeClosesChat(esc(), body, true), false);
    assert.equal(escapeClosesChat(esc(), { tagName: 'TEXTAREA', composerEmpty: true }, true), false);
  });
  test('already handled (cancel reply / edit, close quick replies), held down, IME, or with modifiers: never', () => {
    assert.equal(escapeClosesChat(esc({ defaultPrevented: true }), body, false), false);
    assert.equal(escapeClosesChat(esc({ repeat: true }), body, false), false);
    assert.equal(escapeClosesChat(esc({ isComposing: true }), body, false), false);
    for (const m of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) assert.equal(escapeClosesChat(esc({ [m]: true }), body, false), false, m);
  });
  test('other keys: never', () => {
    for (const key of ['Enter', 'Backspace', 'Delete', 'Esc ', 'a']) assert.equal(escapeClosesChat(esc({ key }), body, false), false, key);
  });
});
