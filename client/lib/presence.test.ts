// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PRESENCE_STYLES, applyPresence, presenceOf } from './presence';

describe('presence: colours and the local mirror of the server state', () => {
  test('green Online, yellow Away, red Offline', () => {
    assert.deepEqual(PRESENCE_STYLES.online, { label: 'Online', color: '#16a34a' });
    assert.deepEqual(PRESENCE_STYLES.away, { label: 'Away', color: '#eab308' });
    assert.deepEqual(PRESENCE_STYLES.offline, { label: 'Offline', color: '#dc2626' });
  });

  test('unknown people are offline; updates replace by user id; identical updates change nothing', () => {
    let map = {};
    assert.equal(presenceOf(map, 'u1'), 'offline');
    assert.equal(presenceOf(map, null), 'offline');
    map = applyPresence(map, { userId: 'u1', status: 'online', lastActiveAt: '2026-10-14T10:00:00.000Z' });
    assert.equal(presenceOf(map, 'u1'), 'online');
    const same = applyPresence(map, { userId: 'u1', status: 'online', lastActiveAt: '2026-10-14T10:00:00.000Z' });
    assert.equal(same, map); // no re-render for a repeat
    map = applyPresence(map, { userId: 'u1', status: 'away', lastActiveAt: '2026-10-14T10:00:00.000Z' });
    assert.equal(presenceOf(map, 'u1'), 'away');
    map = applyPresence(map, { userId: 'u2', status: 'online', lastActiveAt: null });
    assert.deepEqual([presenceOf(map, 'u1'), presenceOf(map, 'u2')], ['away', 'online']);
    map = applyPresence(map, { userId: 'u1', status: 'offline', lastActiveAt: null });
    assert.equal(presenceOf(map, 'u1'), 'offline');
  });
});
