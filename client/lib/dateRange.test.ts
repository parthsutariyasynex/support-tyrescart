// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { inRange, matchPreset, monthGrid, parseYmd, pickDay, presetRange, todayYmd, ymd } from './dateRange';

// Device time zones the result must not depend on (UTC, India, US west coast, UTC+14)
function inEveryMachineZone(check: () => void) {
  const original = process.env.TZ;
  try {
    for (const tz of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      process.env.TZ = tz;
      check();
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

describe('date range picker', () => {
  const now = new Date('2026-10-15T10:30:00Z'); // 14:30 on 15 Oct 2026 in Dubai
  test('presets: today, yesterday, last 7 and last 30 days include today', () => {
    assert.deepEqual(presetRange('today', now), { from: '2026-10-15', to: '2026-10-15' });
    assert.deepEqual(presetRange('yesterday', now), { from: '2026-10-14', to: '2026-10-14' });
    assert.deepEqual(presetRange('last7', now), { from: '2026-10-09', to: '2026-10-15' });
    assert.deepEqual(presetRange('last30', now), { from: '2026-09-16', to: '2026-10-15' });
    assert.equal(presetRange('custom', now), null);
  });
  test('"today" is today in Dubai, whatever the device time zone', () => {
    inEveryMachineZone(() => {
      assert.equal(todayYmd(new Date('2026-10-15T19:59:00Z')), '2026-10-15'); // 23:59 Dubai (00:29 on the 16th in India)
      assert.equal(todayYmd(new Date('2026-10-15T20:00:00Z')), '2026-10-16'); // 00:00 Dubai (still the 15th in UTC)
      assert.deepEqual(presetRange('yesterday', new Date('2026-10-15T20:00:00Z')), { from: '2026-10-15', to: '2026-10-15' });
      assert.deepEqual(presetRange('last7', new Date('2026-03-01T06:00:00Z')), { from: '2026-02-23', to: '2026-03-01' });
      assert.deepEqual(monthGrid(2026, 9)[0].slice(0, 5), [null, null, null, null, '2026-10-01']);
    });
  });
  test('a from/to pair is recognised as its preset, otherwise custom; empty is none', () => {
    assert.equal(matchPreset('2026-10-09', '2026-10-15', now), 'last7');
    assert.equal(matchPreset('2026-10-14', '2026-10-14', now), 'yesterday');
    assert.equal(matchPreset('2026-10-01', '2026-10-03', now), 'custom');
    assert.equal(matchPreset('', '', now), null);
  });
  test('month grid: October 2026 starts on Thursday, weeks of 7, 31 days', () => {
    const g = monthGrid(2026, 9);
    assert.ok(g.every((w) => w.length === 7));
    assert.deepEqual(g[0].slice(0, 5), [null, null, null, null, '2026-10-01']);
    assert.equal(g.flat().filter(Boolean).length, 31);
    assert.equal(g.flat().filter(Boolean).at(-1), '2026-10-31');
    assert.equal(monthGrid(2024, 1).flat().filter(Boolean).length, 29); // leap February
  });
  test('picking days: start, then end in either order, then start over', () => {
    let r = pickDay({ from: '', to: '' }, '2026-10-05');
    assert.deepEqual(r, { from: '2026-10-05', to: '' });
    assert.deepEqual(pickDay(r, '2026-10-09'), { from: '2026-10-05', to: '2026-10-09' });
    assert.deepEqual(pickDay(r, '2026-10-01'), { from: '2026-10-01', to: '2026-10-05' });
    r = { from: '2026-10-01', to: '2026-10-05' };
    assert.deepEqual(pickDay(r, '2026-10-20'), { from: '2026-10-20', to: '' });
    assert.equal(inRange('2026-10-03', r.from, r.to), true);
    assert.equal(inRange('2026-10-06', r.from, r.to), false);
    assert.equal(ymd(new Date(Date.UTC(2026, 0, 5))), '2026-01-05');
    assert.equal(ymd(parseYmd('2026-03-01')), '2026-03-01');
  });
});
