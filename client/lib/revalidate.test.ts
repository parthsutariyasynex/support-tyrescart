// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { REVALIDATE_MIN_GAP_MS, shouldRevalidate } from './revalidate';

describe('revalidate on return: at most once per gap', () => {
  test('refreshes once the gap has passed since the last load, not before', () => {
    const t0 = 1_000_000;
    assert.equal(shouldRevalidate(t0, t0), false);
    assert.equal(shouldRevalidate(t0, t0 + REVALIDATE_MIN_GAP_MS - 1), false);
    assert.equal(shouldRevalidate(t0, t0 + REVALIDATE_MIN_GAP_MS), true);
    assert.equal(shouldRevalidate(t0, t0 + 60_000), true);
    assert.equal(shouldRevalidate(t0, t0 + 1_000, 500), true); // custom gap
  });
});
