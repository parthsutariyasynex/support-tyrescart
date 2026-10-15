// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { snoozeChoices, snoozedUntilText, zonedAt } from './snooze';

describe('snooze choices (Dubai time, like the rest of the app)', () => {
  const now = new Date('2026-10-15T10:30:00Z'); // Thursday 15 Oct 2026, 14:30 in Dubai (UTC+4)
  const c = Object.fromEntries(snoozeChoices(now).map((x) => [x.key, x.until]));
  test('1 hour and 3 hours are relative', () => {
    assert.equal(c['1h'].getTime() - now.getTime(), 3600_000);
    assert.equal(c['3h'].getTime() - now.getTime(), 3 * 3600_000);
  });
  test('tomorrow 9:00 and next Monday 9:00 are 9:00 in Dubai', () => {
    assert.equal(c.tomorrow.toISOString(), '2026-10-16T05:00:00.000Z');
    assert.equal(c.monday.toISOString(), '2026-10-19T05:00:00.000Z');
    for (const x of snoozeChoices(now)) assert.ok(x.until > now);
  });
  test('on a Monday, "Monday" means next week; late at night, "tomorrow" is the next Dubai day', () => {
    const monday = new Date('2026-10-19T04:00:00Z'); // Mon 08:00 Dubai
    assert.equal(snoozeChoices(monday).find((x) => x.key === 'monday')!.until.toISOString(), '2026-10-26T05:00:00.000Z');
    const lateNight = new Date('2026-10-15T21:30:00Z'); // Fri 16 Oct 01:30 in Dubai
    assert.equal(snoozeChoices(lateNight).find((x) => x.key === 'tomorrow')!.until.toISOString(), '2026-10-17T05:00:00.000Z');
  });
  test('zonedAt and the label use the app time zone', () => {
    assert.equal(zonedAt(2026, 1, 5, 9).toISOString(), '2026-01-05T05:00:00.000Z');
    assert.equal(snoozedUntilText('2026-10-15T10:16:00Z', 'en-GB'), '15 Oct, 14:16');
    assert.equal(snoozedUntilText(null), '');
  });
});
