// The reminder schedule itself (no sockets: nobody is connected, so emits are no-ops). Run: npm run test:e2e
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { prisma } from '../src/prisma.js';
import { startAssignmentReminders } from '../src/services/assignmentReminders.js';

describe('assignment reminder schedule', () => {
  after(() => prisma.$disconnect());

  test('ticks on the interval and stops cleanly', async () => {
    const ticks: number[] = [];
    const stop = startAssignmentReminders(0.01, (n) => ticks.push(n)); // 0.6 s
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
});
