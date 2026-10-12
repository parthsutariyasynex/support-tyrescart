// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { workspaceDetails } from './workspaces';

describe('workspace switcher: telling same-named workspaces apart', () => {
  const now = Date.parse('2026-10-12T09:00:00Z');
  test('only duplicates get a creation date and the end of their id', () => {
    const d = workspaceDetails(
      [
        { id: 'cmv0tct2q0005nr5zqias0wfi', name: 'support-tyrescart', createdAt: '2026-10-09T08:00:00Z' },
        { id: 'cmv0tx3hr001wnrdeol6wofyo', name: 'Support-Tyrescart ', createdAt: '2026-10-09T08:30:00Z' },
        { id: 'cmv5634o600t1nrglv9ek0m6d', name: 'tyresvesion', createdAt: '2026-10-12T08:00:00Z' },
      ],
      now,
    );
    const a = d.get('cmv0tct2q0005nr5zqias0wfi')!;
    const b = d.get('cmv0tx3hr001wnrdeol6wofyo')!;
    assert.match(a, /^created .+ · #0wfi$/);
    assert.match(b, /#ofyo$/);
    assert.notEqual(a, b);
    assert.equal(d.get('cmv5634o600t1nrglv9ek0m6d'), null);
  });
  test('without a creation date the id end still tells them apart', () => {
    const d = workspaceDetails([{ id: 'aaaa1111', name: 'Shop' }, { id: 'bbbb2222', name: 'shop' }]);
    assert.deepEqual([d.get('aaaa1111'), d.get('bbbb2222')], ['#1111', '#2222']);
  });
});
