// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { countdown, toolText } from './aiRobot';

describe('AI Robot tab', () => {
  test('countdown until the robot replies', () => {
    const now = Date.parse('2026-11-04T10:00:00Z');
    assert.equal(countdown('2026-11-04T10:03:12Z', now), '3:12');
    assert.equal(countdown('2026-11-04T10:00:05.200Z', now), '0:06', 'part of a second counts as a second');
    assert.equal(countdown('2026-11-04T11:02:03Z', now), '1:02:03');
    assert.equal(countdown('2026-11-04T09:59:00Z', now), '0:00', 'never negative');
  });
  test('what the robot looked up, as people read it', () => {
    assert.equal(toolText('search_tyres 245/40 R18: 5 of 9'), 'Searched tyres 245/40 R18: 5 of 9');
    assert.equal(toolText('find_tyre_size failed: The Tyrescart catalogue answered HTTP 403'), 'Looked up the car’s tyre size: failed: The Tyrescart catalogue answered HTTP 403');
    assert.equal(toolText('search_web answered'), 'Searched the web: answered');
  });
});
