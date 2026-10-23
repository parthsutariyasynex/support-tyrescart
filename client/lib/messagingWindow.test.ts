// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { WINDOW_MS, lastCustomerMessageAt, msUntilClose, windowOpen } from './messagingWindow';

describe('24-hour window on the chat screen', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();

  test('open within 24 hours of the last customer message, closed after; closed when they never wrote', () => {
    assert.equal(windowOpen(Date.parse(ago(23)), now), true);
    assert.equal(windowOpen(now - WINDOW_MS, now), false);
    assert.equal(windowOpen(Date.parse(ago(30)), now), false);
    assert.equal(windowOpen(null, now), false);
  });
  test("a customer message that just arrived live reopens it, even before the chat's own time updates", () => {
    const at = lastCustomerMessageAt(ago(30), [
      { direction: 'in', createdAt: ago(30) },
      { direction: 'out', createdAt: ago(1) }, // ours don't count
      { direction: 'in', createdAt: ago(0.01) },
    ]);
    assert.equal(windowOpen(at, now), true);
    assert.equal(lastCustomerMessageAt(ago(30), [{ direction: 'out', createdAt: ago(1) }]), Date.parse(ago(30)));
    assert.equal(lastCustomerMessageAt(null, []), null);
    assert.equal(lastCustomerMessageAt(null, [{ direction: 'in', createdAt: ago(2) }]), Date.parse(ago(2)));
  });
  test('time left until it closes, for the timer that switches the box to templates', () => {
    assert.equal(msUntilClose(Date.parse(ago(23)), now), 3_600_000);
    assert.equal(msUntilClose(Date.parse(ago(25)), now), null);
    assert.equal(msUntilClose(null, now), null);
  });
});
