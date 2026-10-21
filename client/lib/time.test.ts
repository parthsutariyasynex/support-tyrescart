// Run: npm test --workspace=client
// Fixed instants below are test inputs only; the app always formats real timestamps from the API.
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { APP_TIME_ZONE, addDays, clockKey, currentTimeZone, dayKey, dayLabel, formatDateTime, formatShortDate, formatTime, listTimestamp, setTimeZone, zonedInstant } from './time';

const L = 'en-GB'; // fixed locale so expected strings are exact (the app uses the viewer's locale)
// The device timezones these must not depend on (UTC, India, US west coast, UTC+14)
const MACHINE_ZONES = ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Kiritimati'];
const originalTz = process.env.TZ;

// Node picks up a changed process.env.TZ immediately
function inEveryMachineZone(check: () => void) {
  for (const tz of MACHINE_ZONES) {
    process.env.TZ = tz;
    check();
  }
}

afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('Dubai time helpers', () => {
  test('uses Asia/Dubai (UTC+4, no daylight saving)', () => {
    assert.equal(APP_TIME_ZONE, 'Asia/Dubai');
    // Same offset in winter and summer
    assert.equal(formatTime('2026-01-15T10:00:00Z', L), '14:00');
    assert.equal(formatTime('2026-07-15T10:00:00Z', L), '14:00');
  });

  test('the machine timezone really changes naive local time (so the checks below mean something)', () => {
    const hours = MACHINE_ZONES.map((tz) => {
      process.env.TZ = tz;
      return new Date('2026-10-10T10:16:20.992Z').getHours();
    });
    assert.equal(new Set(hours).size, MACHINE_ZONES.length);
  });

  test('UTC from the API is shown in Dubai time, whatever the device timezone', () => {
    inEveryMachineZone(() => {
      assert.equal(formatTime('2026-10-10T10:16:20.992Z', L), '14:16');
      assert.equal(formatDateTime('2026-10-10T10:16:20.992Z', L), '10 Oct 2026, 14:16');
      assert.equal(dayKey('2026-10-10T10:16:20.992Z'), '2026-10-10');
    });
  });

  test('a saved time zone preference (a person\'s or the workspace\'s) does not change it: always Dubai', () => {
    setTimeZone('Asia/Kolkata', 'Asia/Kolkata');
    assert.equal(currentTimeZone(), 'Asia/Dubai');
    assert.equal(formatTime('2026-10-10T10:16:20.992Z', L), '14:16');
  });

  test('a Dubai day and time to the exact instant (filters, reports), whatever the device timezone', () => {
    inEveryMachineZone(() => {
      assert.equal(zonedInstant('2026-10-21').toISOString(), '2026-10-20T20:00:00.000Z');
      assert.equal(zonedInstant('2026-10-21', '23:59:59.999').toISOString(), '2026-10-21T19:59:59.999Z');
      assert.equal(zonedInstant('2026-01-01', '03:30').toISOString(), '2025-12-31T23:30:00.000Z');
      assert.equal(clockKey('2026-10-21T10:30:05Z'), '14:30:05');
      assert.equal(clockKey('2026-10-21T20:00:00Z'), '00:00:00');
    });
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  });

  test('accepts ISO strings, Date objects and epoch milliseconds', () => {
    const iso = '2026-10-10T10:16:20.992Z';
    assert.equal(formatTime(new Date(iso), L), '14:16');
    assert.equal(formatTime(Date.parse(iso), L), '14:16');
  });

  test('midnight boundary: the Dubai day starts at 20:00 UTC', () => {
    inEveryMachineZone(() => {
      assert.equal(dayKey('2026-10-11T19:59:59.999Z'), '2026-10-11'); // 23:59:59.999 in Dubai
      assert.equal(dayKey('2026-10-11T20:00:00.000Z'), '2026-10-12'); // 00:00 in Dubai, still the 11th in UTC
      assert.equal(formatTime('2026-10-11T20:30:00Z', L), '00:30');
    });
  });

  test('day separators: Today, Yesterday, then the date, by Dubai calendar day', () => {
    const now = '2026-10-12T09:00:00Z'; // Mon 12 Oct, 13:00 in Dubai
    inEveryMachineZone(() => {
      assert.equal(dayLabel('2026-10-12T08:59:00Z', now, L), 'Today');
      assert.equal(dayLabel('2026-10-11T20:30:00Z', now, L), 'Today'); // 00:30 Dubai on the 12th (UTC says the 11th)
      assert.equal(dayLabel('2026-10-11T19:30:00Z', now, L), 'Yesterday'); // 23:30 Dubai on the 11th
      assert.equal(dayLabel('2026-10-10T20:00:00Z', now, L), 'Yesterday'); // 00:00 Dubai on the 11th
      assert.equal(dayLabel('2026-10-10T19:59:00Z', now, L), 'Sat 10 Oct'); // 23:59 Dubai on the 10th
      assert.equal(dayLabel('2025-10-10T10:00:00Z', now, L), 'Fri, 10 Oct 2025'); // another year shows it
    });
  });

  test('just after Dubai midnight, the previous evening is Yesterday even though UTC is still on that day', () => {
    const now = '2026-10-11T20:05:00Z'; // 00:05 Dubai on the 12th
    assert.equal(dayLabel('2026-10-11T19:55:00Z', now, L), 'Yesterday'); // 23:55 Dubai on the 11th
    assert.equal(listTimestamp('2026-10-11T19:55:00Z', now, L), 'Yesterday');
    assert.equal(listTimestamp('2026-10-11T20:01:00Z', now, L), '00:01');
  });

  test('new year in Dubai comes 4 hours before UTC', () => {
    const now = '2026-12-31T21:00:00Z'; // 01:00 Dubai on 1 Jan 2027
    assert.equal(dayLabel('2026-12-31T20:30:00Z', now, L), 'Today'); // 00:30 Dubai, 1 Jan
    assert.equal(dayLabel('2026-12-31T19:00:00Z', now, L), 'Yesterday'); // 23:00 Dubai, 31 Dec
    assert.equal(dayLabel('2026-12-30T10:00:00Z', now, L), 'Wed, 30 Dec 2026'); // last year, so the year is shown
    assert.equal(formatShortDate('2026-12-30T10:00:00Z', now, L), '30 Dec 2026');
  });

  test('conversation list: time today, Yesterday, then a short date', () => {
    const now = '2026-10-12T09:00:00Z';
    inEveryMachineZone(() => {
      assert.equal(listTimestamp('2026-10-12T05:45:00Z', now, L), '09:45');
      assert.equal(listTimestamp('2026-10-11T05:45:00Z', now, L), 'Yesterday');
      assert.equal(listTimestamp('2026-10-09T11:27:05.309Z', now, L), '9 Oct');
      // 2025 in UTC but 1 Jan 2026 in Dubai: same year as now, so no year
      assert.equal(listTimestamp('2025-12-31T21:00:00Z', now, L), '1 Jan');
    });
  });

  test('notifications: short date in Dubai time, with the year only when it differs', () => {
    const now = '2026-10-12T09:00:00Z';
    assert.equal(formatShortDate('2026-10-09T20:30:00Z', now, L), '10 Oct'); // 00:30 Dubai on the 10th
    assert.equal(formatShortDate('2025-10-09T08:00:00Z', now, L), '9 Oct 2025');
  });
});
