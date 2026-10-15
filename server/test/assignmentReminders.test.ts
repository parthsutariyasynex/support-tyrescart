// The reminder schedule itself (no sockets: nobody is connected, so emits are no-ops). Run: npm run test:e2e
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { prisma } from '../src/prisma.js';
import { isDue, pendingSince, startAssignmentReminders } from '../src/services/assignmentReminders.js';

describe('assignment reminder schedule', () => {
  after(() => prisma.$disconnect());

  test('ticks on the interval and stops cleanly', async () => {
    const ticks: number[] = [];
    const stop = startAssignmentReminders(0.01, (n) => ticks.push(n), 'no-such-workspace'); // 0.6 s, touches no data
    await new Promise((r) => setTimeout(r, 2000));
    stop();
    const after = ticks.length;
    assert.ok(after >= 2, `expected at least 2 ticks in 2 s, got ${after}`);
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(ticks.length, after); // nothing after stop
    for (const n of ticks) assert.ok(Number.isInteger(n) && n >= 0);
  });

  test('0 or an invalid interval disables it', async () => {
    const ticks: number[] = [];
    const stops = [startAssignmentReminders(0, (n) => ticks.push(n)), startAssignmentReminders(Number.NaN, (n) => ticks.push(n)), startAssignmentReminders(-5, (n) => ticks.push(n))];
    await new Promise((r) => setTimeout(r, 300));
    stops.forEach((s) => s());
    assert.deepEqual(ticks, []);
  });

  test('when a chat is due: 5 minutes after it became pending, then 5 minutes after each reminder', () => {
    const t0 = new Date('2026-10-15T10:00:00Z');
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    const base = { unread: 1, lastInboundAt: t0, createdAt: t0, updatedAt: t0, assignedAt: null, assigneeOpenedAt: null, assignedTo: null, reminderSentAt: null };
    const ms = 5 * 60_000;
    // unassigned + unread
    assert.equal(pendingSince(base)?.getTime(), t0.getTime());
    assert.equal(isDue(base, at(4.9), ms), false);
    assert.equal(isDue(base, at(5), ms), true);
    assert.equal(isDue({ ...base, reminderSentAt: at(5) }, at(9), ms), false);
    assert.equal(isDue({ ...base, reminderSentAt: at(5) }, at(10), ms), true);
    assert.equal(pendingSince({ ...base, unread: 0 }), null); // read: nothing to remind
    // assigned, not opened: counts from the assignment
    const assigned = { ...base, unread: 0, assignedAt: at(20), assignedTo: { userId: 'u', active: true } };
    assert.equal(isDue({ ...assigned, reminderSentAt: at(10) }, at(24), ms), false); // an older reminder doesn't count
    assert.equal(isDue({ ...assigned, reminderSentAt: at(10) }, at(25), ms), true);
    // assigned and opened: only new unread customer messages make it pending again
    assert.equal(pendingSince({ ...assigned, assigneeOpenedAt: at(21) }), null);
    assert.equal(pendingSince({ ...assigned, assigneeOpenedAt: at(21), unread: 2, lastInboundAt: at(30) })?.getTime(), at(30).getTime());
    // inactive assignee, or reminders off
    assert.equal(pendingSince({ ...assigned, assignedTo: { userId: 'u', active: false } }), null);
    assert.equal(isDue(base, at(100), 0), false);
  });
});
