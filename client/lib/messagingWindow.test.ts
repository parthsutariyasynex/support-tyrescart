// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { WINDOW_MS, isWindowClosedError, lastCustomerMessageAt, msUntilClose, windowOpen } from './messagingWindow';

describe('24-hour window on the chat screen', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();

  test('open within 24 hours of the last customer message, closed after; closed when they never wrote', () => {
    assert.equal(windowOpen(Date.parse(ago(23)), now), true);
    assert.equal(windowOpen(now - WINDOW_MS, now), false);
    assert.equal(windowOpen(Date.parse(ago(30)), now), false);
    assert.equal(windowOpen(null, now), false);
  });
  test("only the server's lastInboundAt counts (Meta's time of the customer's message), never when a webhook arrived", () => {
    assert.equal(lastCustomerMessageAt(ago(30)), Date.parse(ago(30)));
    assert.equal(windowOpen(lastCustomerMessageAt(ago(30)), now), false); // a webhook delivered late doesn't reopen it
    assert.equal(windowOpen(lastCustomerMessageAt(ago(0.01)), now), true); // a new customer message (message:new) does
    assert.equal(lastCustomerMessageAt(null), null);
    assert.equal(lastCustomerMessageAt('not a date'), null);
  });
  test('a server refusal for the closed window is recognised (GraphQL code or upload message)', () => {
    assert.equal(isWindowClosedError(new Error('x'), 'WINDOW_CLOSED'), true);
    assert.equal(isWindowClosedError(new Error('24-hour window closed. Send an approved template instead.')), true);
    assert.equal(isWindowClosedError(new Error('This chat is closed. Reopen it to reply.'), 'CONVERSATION_CLOSED'), false);
  });
  test('time left until it closes, for the timer that switches the box to templates', () => {
    assert.equal(msUntilClose(Date.parse(ago(23)), now), 3_600_000);
    assert.equal(msUntilClose(Date.parse(ago(25)), now), null);
    assert.equal(msUntilClose(null, now), null);
  });
});
