import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clock, gmtOffset, workingHoursText } from './automations';

test('working hours summary, as SleekFlow shows it', () => {
  assert.equal(clock('09:00'), '9:00 AM');
  assert.equal(clock('18:00'), '6:00 PM');
  assert.equal(clock('00:30'), '12:30 AM');
  assert.equal(clock('12:05'), '12:05 PM');
  assert.equal(gmtOffset('Asia/Dubai'), 'GMT+4');
  assert.equal(gmtOffset('Asia/Kolkata'), 'GMT+5:30');
  const days = (list: number[], start = '09:00', end = '18:00') => list.map((day) => ({ day, start, end }));
  assert.equal(workingHoursText({ workingHours: days([1, 2, 3, 4, 5, 6]), timeZone: 'Asia/Dubai' }), 'Mon, Tue, Wed, Thu, Fri, Sat 9:00 AM - 6:00 PM (GMT+4)');
  assert.equal(workingHoursText({ workingHours: days([6, 0], '10:00', '14:00'), timeZone: 'Asia/Dubai' }), 'Sat, Sun 10:00 AM - 2:00 PM (GMT+4)');
  assert.equal(
    workingHoursText({ workingHours: [...days([1, 2]), ...days([6], '10:00', '14:00')], timeZone: 'Asia/Dubai' }),
    'Mon, Tue 9:00 AM - 6:00 PM · Sat 10:00 AM - 2:00 PM (GMT+4)',
  );
  assert.equal(workingHoursText({ workingHours: days([0, 1, 2, 3, 4, 5, 6], '00:00', '23:59'), timeZone: 'Asia/Dubai' }), 'Every day, 24 hours (GMT+4)');
  assert.equal(workingHoursText({ workingHours: [], timeZone: 'Asia/Dubai' }), 'Closed every day (GMT+4)');
});
