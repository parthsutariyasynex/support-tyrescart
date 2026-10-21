// Dubai time on the server (CSV exports, file names, working hours). No server/DB needed.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { APP_TIME_ZONE, dubaiDay, dubaiIso } from '../src/time.js';
import { withinWorkingHours } from '../src/services/automations.js';

// The server's own time zone must not matter (UTC, India, US west coast, UTC+14)
function inEveryServerZone(check: () => void) {
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

describe('Dubai time on the server', () => {
  test('stored UTC shown as Dubai wall time with its offset, whatever the server time zone', () => {
    assert.equal(APP_TIME_ZONE, 'Asia/Dubai');
    inEveryServerZone(() => {
      assert.equal(dubaiIso(new Date('2026-10-14T07:30:00.000Z')), '2026-10-14T11:30:00+04:00');
      assert.equal(dubaiIso(new Date('2026-07-01T00:00:00.000Z')), '2026-07-01T04:00:00+04:00'); // no daylight saving
      // the Dubai day starts at 20:00 UTC (India is already 1:30 later)
      assert.equal(dubaiDay(new Date('2026-10-14T19:59:59.000Z')), '2026-10-14');
      assert.equal(dubaiDay(new Date('2026-10-14T20:00:00.000Z')), '2026-10-15');
      assert.equal(dubaiDay(new Date('2026-10-14T18:45:00.000Z')), '2026-10-14'); // 00:15 on the 15th in India
      assert.equal(new Date(dubaiIso(new Date('2026-10-14T07:30:00.000Z'))).toISOString(), '2026-10-14T07:30:00.000Z'); // round-trips
    });
  });

  test('automation working hours are Dubai hours, not the server\'s', () => {
    const s = { workingDays: '1,2,3,4,5', workStart: '09:00', workEnd: '18:00' };
    inEveryServerZone(() => {
      assert.equal(withinWorkingHours(s, APP_TIME_ZONE, new Date('2026-10-21T05:00:00Z')), true); // 09:00 Dubai (10:30 India)
      assert.equal(withinWorkingHours(s, APP_TIME_ZONE, new Date('2026-10-21T04:00:00Z')), false); // 08:00 Dubai (09:30 India)
      assert.equal(withinWorkingHours(s, APP_TIME_ZONE, new Date('2026-10-21T13:45:00Z')), true); // 17:45 Dubai (19:15 India)
    });
  });
});
