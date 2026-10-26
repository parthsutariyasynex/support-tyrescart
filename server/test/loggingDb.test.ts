// Centralized logging against the real database: entries are saved in LogEntry (level, event, request id, time,
// sanitized data), and when a write fails the entry goes to the terminal instead. Needs the local database with the
// LogEntry table (npm run db:push); removes only the rows it wrote. `npx tsx --test test/loggingDb.test.ts`
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { prisma } from '../src/prisma.js';
import { logEvent, runWithRequest, setLogWriter, setRequestUser } from '../src/services/logging.js';

const requestId = `test-logdb-${Date.now()}`;
after(async () => {
  setLogWriter();
  await prisma.logEntry.deleteMany({ where: { requestId: { startsWith: 'test-logdb-' } } });
  await prisma.$disconnect();
});

test('SUCCESS, WARNING and ERROR entries are saved with their time, level, event and request id', async () => {
  const before = new Date(Date.now() - 1000);
  await runWithRequest(requestId, async () => {
    setRequestUser({ userId: 'test-user', workspaceId: 'test-workspace' });
    await logEvent({ level: 'SUCCESS', category: 'auth', event: 'login.success', message: 'Signed in', data: { email: 'a@example.com', password: 'never-saved' } });
    await logEvent({ level: 'WARNING', category: 'permission', event: 'permission.denied', message: 'Refused: admin-only action', errorCode: 'FORBIDDEN' });
    await logEvent({ level: 'ERROR', category: 'message', event: 'message.status', message: "WhatsApp didn't deliver a message", errorCode: 131049, durationMs: 5 });
  });
  const rows = await prisma.logEntry.findMany({ where: { requestId }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(
    rows.map((r) => [r.level, r.event, r.errorCode]).sort(),
    [
      ['ERROR', 'message.status', '131049'],
      ['SUCCESS', 'login.success', null],
      ['WARNING', 'permission.denied', 'FORBIDDEN'],
    ],
  );
  for (const r of rows) {
    assert.ok(r.createdAt >= before && r.createdAt <= new Date(Date.now() + 1000), 'createdAt is now');
    assert.equal(r.workspaceId, 'test-workspace');
    assert.equal(r.userId, 'test-user');
  }
  const success = rows.find((r) => r.level === 'SUCCESS')!;
  assert.deepEqual(success.data, { email: 'a@example.com', password: '[REDACTED]' });
  assert.equal(rows.find((r) => r.level === 'ERROR')!.durationMs, 5);
});

test('a failed database write prints the entry to the terminal, saves nothing and never throws', async () => {
  const failingId = `${requestId}-fail`;
  setLogWriter(async () => {
    throw new Error('simulated database outage');
  });
  const lines: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ['log', 'warn', 'error'] as const) console[k] = (...a: unknown[]) => void lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  try {
    await assert.doesNotReject(logEvent({ level: 'ERROR', category: 'webhook', event: 'webhook.failed', message: 'boom', requestId: failingId }));
  } finally {
    Object.assign(console, saved);
    setLogWriter();
  }
  assert.ok(lines.some((l) => l.includes("Couldn't save logs to the database") && l.includes('simulated database outage')));
  assert.ok(lines.some((l) => l.startsWith('[log, not saved] ERROR webhook webhook.failed: boom') && l.includes(failingId)));
  assert.equal(await prisma.logEntry.count({ where: { requestId: failingId } }), 0);
  // Back on the database writer: saving works again
  await logEvent({ level: 'SUCCESS', category: 'http', event: 'http.request', message: 'recovered', requestId });
  assert.equal(await prisma.logEntry.count({ where: { requestId, message: 'recovered' } }), 1);
});

test("an incoming message is logged as message.received, with Meta's error code and message when it has them", async () => {
  const { saveIncoming, parseWebhookMessage } = await import('../src/messages.js');
  const ws = await prisma.workspace.create({ data: { name: `test-logdb-received-${Date.now()}` } });
  const captured: import('../src/services/logging.js').LogRecord[] = [];
  setLogWriter(async (r) => void captured.push(r));
  try {
    const at = String(Math.floor(Date.now() / 1000));
    await saveIncoming(ws.id, parseWebhookMessage({ from: '971500000777', id: `wamid.logdb-ok-${Date.now()}`, timestamp: at, type: 'text', text: { body: 'secret text' } }));
    await saveIncoming(
      ws.id,
      parseWebhookMessage({
        from: '971500000777',
        id: `wamid.logdb-err-${Date.now()}`,
        timestamp: at,
        type: 'unsupported',
        unsupported: { type: 'poll_creation' },
        errors: [{ code: 131051, title: 'Message type unknown', error_data: { details: 'Message type is currently not supported.' } }],
      }),
    );
    await new Promise((r) => setImmediate(r));
    const received = captured.filter((r) => r.event === 'message.received' && r.workspaceId === ws.id);
    assert.equal(received.length, 2);
    const [ok, err] = received;
    assert.deepEqual([ok.level, ok.errorCode, (ok.data as any).providerErrorCode, (ok.data as any).providerErrorMessage], ['SUCCESS', null, null, null]);
    assert.deepEqual([err.level, err.errorCode, (err.data as any).providerErrorCode, (err.data as any).providerErrorMessage], [
      'WARNING',
      '131051',
      131051,
      'Message type unknown: Message type is currently not supported.',
    ]);
    assert.match(err.message, /WhatsApp: Message type unknown/);
    assert.doesNotMatch(JSON.stringify(received), /secret text|971500000777/, "never the customer's text or number");
  } finally {
    setLogWriter();
    await prisma.workspace.delete({ where: { id: ws.id } });
  }
});
