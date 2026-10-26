// End-to-end tracking of WhatsApp messages in the logs: the send (its exact request), Meta's answer (accepted,
// refused, timed out, unreadable), each delivery status, the webhook's payload (once), and the trace/audit tool that
// reads the files back. By default customer data is logged (text, numbers, wamids); LOG_CUSTOMER_DATA=false keeps it
// out (numbers masked, wamids as references). Secrets are redacted either way, and every entry is numbered.
// No database: Meta is a local mock, entries are captured or written to a temporary folder.
// `npx tsx --test test/messageTracking.test.ts`
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

type Reply = { status: number; body: string; type?: string; hang?: boolean };
let next: Reply = { status: 200, body: '{}' };
const mock = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (next.hang) return; // never answers: the call must time out
    res.writeHead(next.status, { 'Content-Type': next.type ?? 'application/json' });
    res.end(next.body);
  });
});

let wa: typeof import('../src/whatsapp.js');
let logging: typeof import('../src/services/logging.js');
let logFile: typeof import('../src/services/logFile.js');
let messages: typeof import('../src/messages.js');
let trace: typeof import('../src/services/messageTrace.js');
let env: typeof import('../src/env.js')['env'];
const saved: import('../src/services/logging.js').LogRecord[] = [];
const account = { phoneNumberId: '106540352242922', accessToken: 'EAAG-test-token-secret' };
const WAMID = 'wamid.HBgMOTcxNTAwMDAwMDAwFQIAERgSQTdFQzlGNERFNzhFMzFBNDcyAA==';
let dir = '';

before(async () => {
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  process.env.GRAPH_API_BASE = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`; // read when env.ts loads
  process.env.META_TIMEOUT_MS = '300';
  dir = await mkdtemp(path.join(tmpdir(), 'msg-tracking-'));
  env = (await import('../src/env.js')).env;
  wa = await import('../src/whatsapp.js');
  logging = await import('../src/services/logging.js');
  logFile = await import('../src/services/logFile.js');
  messages = await import('../src/messages.js');
  trace = await import('../src/services/messageTrace.js');
  logFile.setLogFileDir(dir);
  logging.setLogWriter(async (r) => saved.push(r));
});
after(async () => {
  logging?.setLogWriter();
  logFile?.setLogFileDir();
  mock.close();
  await rm(dir, { recursive: true, force: true });
});

const settle = () => new Promise((r) => setImmediate(r)); // entries are logged without awaiting
const last = async (event?: string) => {
  await settle();
  return [...saved].reverse().find((r) => !event || r.event === event)!;
};

describe('LOG_CUSTOMER_DATA=false: customer data stays out of the logs', () => {
  before(() => void (env.logCustomerData = false));
  after(() => void (env.logCustomerData = true));
  test('a wamid is kept only as a stable one-way reference', () => {
    const ref = logging.waRef(WAMID);
    assert.match(ref, /^wa:[0-9a-f]{16}$/);
    assert.equal(logging.waRef(WAMID), ref, 'same id, same reference');
    assert.equal(logging.waRef(ref), ref, 'a reference stays as it is');
    const r = logging.toRecord({ level: 'SUCCESS', category: 'message', event: 'message.sent', message: `sent ${WAMID}`, waMessageId: WAMID });
    assert.equal(r.waMessageRef, ref);
    assert.equal(r.waMessageId, null);
    assert.equal(r.message, `sent ${ref}`, 'a wamid in text is replaced too');
    assert.doesNotMatch(JSON.stringify(r), /wamid\.|971500000000/);
  });
  test('phone numbers, the customer and their words are masked; ids, times and counts are not', () => {
    const clean = logging.sanitize({
      to: '971500000000',
      wa_id: '971500000000',
      recipient_id: '971500000000',
      body: 'my number is +971 50 000 0000',
      caption: 'hi',
      contacts: [{ wa_id: '971500000000', profile: { name: 'Riya' } }],
      mediaId: '1234567890123',
      phoneNumberId: '106540352242922',
      note: 'call +971500000000 or 971500000000',
      messageId: 'cmvp0z80h0006zjcl7polihi8',
      metaTimestamp: 1793012612,
      bytes: 129105,
      requestId: 'c92fa7a1-70d9-4bd2-98cc-590078065120',
    }) as Record<string, unknown>;
    for (const k of ['to', 'wa_id', 'recipient_id', 'body', 'caption', 'contacts']) assert.equal(clean[k], '[REDACTED]', k);
    assert.match(String(clean.mediaId), /^wa:[0-9a-f]{16}$/);
    assert.match(String(clean.phoneNumberId), /^wa:[0-9a-f]{16}$/);
    assert.equal(clean.note, 'call [phone] or [phone]');
    assert.equal(clean.messageId, 'cmvp0z80h0006zjcl7polihi8');
    assert.equal(clean.metaTimestamp, 1793012612);
    assert.equal(clean.bytes, 129105);
    assert.equal(clean.requestId, 'c92fa7a1-70d9-4bd2-98cc-590078065120');
  });
  test('no message text, and the payloads sent to Meta lose the customer fields', () => {
    const r = logging.toRecord({
      level: 'SUCCESS', category: 'whatsapp', event: 'whatsapp.send', message: 'm', content: 'Call me on 971500000000',
      request: { messaging_product: 'whatsapp', to: '971500000000', type: 'text', text: { body: 'hello' } },
    });
    assert.equal(r.content, null);
    assert.deepEqual(r.request, { messaging_product: 'whatsapp', to: '[REDACTED]', type: 'text', text: '[REDACTED]' });
  });
});

describe('LOG_CUSTOMER_DATA (default): everything needed to trace a message, secrets still redacted', () => {
  test('on by default', () => assert.equal(env.logCustomerData, true));
  test('the wamid itself and its reference; text, numbers and payloads as they are', () => {
    const r = logging.toRecord({
      level: 'SUCCESS', category: 'message', event: 'message.received', message: `from 971500000000 ${WAMID}`, waMessageId: WAMID,
      content: 'Do you have 205/55 R16? Call me on +971500000000', data: { from: '971500000000', senderName: 'Riya' },
    });
    assert.deepEqual([r.waMessageId, r.waMessageRef], [WAMID, logging.waRef(WAMID)]);
    assert.equal(r.content, 'Do you have 205/55 R16? Call me on +971500000000');
    assert.equal(r.message, `from 971500000000 ${WAMID}`);
    assert.deepEqual(r.data, { from: '971500000000', senderName: 'Riya' });
  });
  test('a whole webhook payload is kept (deep nesting, full text); passwords, tokens and live links are not', () => {
    const text = 'x'.repeat(3000);
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: '1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '106540352242922' }, messages: [{ from: '971500000000', id: WAMID, type: 'text', text: { body: text } }] } }] }],
      access_token: 'EAAG-leaked', note: 'Authorization: Bearer EAAGabcdefghijklmnop', link: 'https://support.example/live/AbCdEfGhIjKlMnOpQrStUvWx',
    };
    const r = logging.toRecord({ level: 'SUCCESS', category: 'webhook', event: 'webhook.received', message: 'm', request: payload }) as any;
    assert.equal(r.request.entry[0].changes[0].value.messages[0].text.body, text, 'deep and long enough for a whole message');
    assert.equal(r.request.entry[0].changes[0].value.messages[0].id, WAMID);
    assert.equal(r.request.access_token, '[REDACTED]');
    assert.equal(r.request.note, 'Authorization: Bearer [REDACTED]');
    assert.equal(r.request.link, 'https://support.example/live/[token]');
  });
  test('the webhook route logs the complete payload once, on its summary entry', async () => {
    const express = (await import('express')).default;
    const crypto = await import('node:crypto');
    const { webhookRouter } = await import('../src/routes/webhook.js');
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => void ((req as any).rawBody = Buffer.from(buf)) }));
    app.use('/webhook', webhookRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      // No phone_number_id: nothing is looked up in the database, only the summary is written
      const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '9', changes: [{ field: 'account_update', value: { event: 'VERIFIED_ACCOUNT', note: 'hello' } }] }] });
      const signature = env.metaAppSecret ? `sha256=${crypto.createHmac('sha256', env.metaAppSecret).update(body).digest('hex')}` : '';
      saved.length = 0;
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(signature ? { 'X-Hub-Signature-256': signature } : {}) }, body });
      assert.equal(res.status, 200);
      for (let i = 0; i < 50 && !saved.some((r) => r.event === 'webhook.received'); i++) await new Promise((r) => setTimeout(r, 10));
      const summaries = saved.filter((r) => r.request !== null);
      assert.equal(summaries.length, 1, 'the payload is in one entry only');
      assert.equal(summaries[0].event, 'webhook.received');
      assert.deepEqual(summaries[0].request, JSON.parse(body));
    } finally {
      server.close();
    }
  });
});

describe('logId', () => {
  test('sequential, and after a restart it continues from the highest one in the folder (older lines skipped)', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'logid-'));
    try {
      // Today's file already has a line from before logIds, and an older day ends at 41
      await writeFile(path.join(folder, '2026-10-25.log'), '{"logId":40,"event":"a"}\n{"logId":41,"event":"b"}\n');
      await writeFile(path.join(folder, '2026-10-26.log'), '{"timestamp":"x","event":"old line without a logId"}\n');
      await writeFile(path.join(folder, 'app-2026-10-24.log'), '2026-10-24 10:00:00.000 +04:00 SUCCESS x old text\n');
      logFile.setLogFileDir(folder);
      assert.deepEqual([logFile.nextLogId(), logFile.nextLogId(), logFile.nextLogId()], [42, 43, 44]);
      await writeFile(path.join(folder, '2026-10-26.log'), '{"logId":44}\n', { flag: 'a' });
      logFile.setLogFileDir(folder); // a restart
      assert.equal(logFile.nextLogId(), 45);
      logFile.setLogFileDir(await mkdtemp(path.join(tmpdir(), 'logid-empty-')));
      assert.equal(logFile.nextLogId(), 1, 'an empty folder starts at 1');
    } finally {
      logFile.setLogFileDir(dir);
      await rm(folder, { recursive: true, force: true });
    }
  });
  test('every entry written gets the next number, in the file and the record', async () => {
    saved.length = 0;
    await logging.logEvent({ level: 'SUCCESS', category: 'system', event: 'server.started', message: 'one' });
    await logging.logEvent({ level: 'SUCCESS', category: 'system', event: 'server.started', message: 'two' });
    assert.equal(saved[1].logId, saved[0].logId! + 1);
    await logFile.flushLogFile();
    const lines = (await readFile(path.join(dir, `${logFile.localDay()}.log`), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.slice(-2).map((l) => [l.logId, l.message]), [[saved[0].logId, 'one'], [saved[1].logId, 'two']]);
  });
});

describe("the send and Meta's answer", () => {
  const base = { workspaceId: 'w1', conversationId: 'c1', messageId: 'm1', type: 'text' };
  test('accepted: messageSent 1, deliveryStatus sent, customerReceived not confirmed', async () => {
    await logging.logMessageSend({ ...base, waMessageId: WAMID, content: 'hello' });
    const r = await last('message.sent');
    assert.deepEqual([r.level, r.messageSent, r.customerReceived, r.deliveryStatus, r.newStatus], ['SUCCESS', 1, null, 'sent', 'sent']);
    assert.deepEqual([r.waMessageId, r.waMessageRef], [WAMID, logging.waRef(WAMID)]);
    assert.equal(r.content, 'hello', 'the text sent');
    assert.match(r.message, /not confirmed until Meta's webhook/);
  });
  test('refused by Meta: messageSent 0, customerReceived 0, and the documented meaning of the code', async () => {
    const err = Object.assign(new wa.GraphApiError('(#131047) Re-engagement message', 400, 131047, 2494010, 'TrAcE1', 'More than 24 hours have passed since the customer last replied.'));
    await logging.logMessageSend({ ...base, error: err });
    const r = await last('message.send_failed');
    assert.deepEqual([r.level, r.outcome, r.messageSent, r.customerReceived, r.deliveryStatus, r.errorCode], ['ERROR', 'refused', 0, 0, 'failed', 131047]);
    assert.match(r.message, /HTTP 400, code 131047\/2494010/);
    assert.match(r.message, /More than 24 hours have passed/);
    assert.match(r.message, /Meta documents code 131047 as/);
    assert.deepEqual(r.response, { ok: false, httpStatus: 400, code: 131047, subcode: 2494010, fbtraceId: 'TrAcE1' });
  });
  test("a code Meta doesn't document here: only Meta's own words, never a guessed meaning", async () => {
    await logging.logMessageSend({ ...base, error: new wa.GraphApiError('Something odd', 400, 999999, null, null, null) });
    const r = await last('message.send_failed');
    assert.match(r.message, /Code 999999 has no documented meaning in this app's list; Meta's own words are above/);
    assert.doesNotMatch(r.message, /documents code/);
  });
  test('a timeout: whether it was sent is unknown (null), never assumed either way', async () => {
    await logging.logMessageSend({ ...base, error: new wa.MetaTimeoutError(30_000) });
    const r = await last('message.send_failed');
    assert.deepEqual([r.outcome, r.messageSent, r.customerReceived, r.deliveryStatus, r.errorCode], ['timeout', null, null, null, 'META_TIMEOUT']);
    assert.match(r.message, /may not have been sent: No answer from Meta within 30 s.*unknown/);
  });
  test('network errors: refused connection = not sent (0); a reset after sending = unknown (null)', async () => {
    const network = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`connect ${code}`), { code }) });
    await logging.logMessageSend({ ...base, error: network('ECONNREFUSED') });
    let r = await last('message.send_failed');
    assert.deepEqual([r.outcome, r.messageSent], ['unreachable', 0]);
    assert.match(r.errorDetails!, /ECONNREFUSED/);
    await logging.logMessageSend({ ...base, error: network('ECONNRESET') });
    r = await last('message.send_failed');
    assert.deepEqual([r.outcome, r.messageSent], ['unreachable', null]);
  });
});

describe('Meta API calls (mock Meta)', () => {
  test('a send inside withMessageTrace names the message; Meta holding it back is a WARNING', async () => {
    next = { status: 200, body: JSON.stringify({ contacts: [{ input: '971500000000', wa_id: '971500000000' }], messages: [{ id: WAMID, message_status: 'held_for_quality_assessment' }] }) };
    const id = await logging.withMessageTrace({ messageId: 'm-traced', conversationId: 'c-traced' }, () => wa.sendText(account, '971500000000', 'secret text'));
    assert.equal(id, WAMID);
    const r = await last('whatsapp.send');
    assert.deepEqual([r.level, r.messageId, r.conversationId, r.messageSent, r.deliveryStatus], ['WARNING', 'm-traced', 'c-traced', 1, 'sent']);
    assert.deepEqual([r.waMessageId, r.waMessageRef], [WAMID, logging.waRef(WAMID)]);
    assert.deepEqual(r.request, { messaging_product: 'whatsapp', to: '971500000000', type: 'text', text: { body: 'secret text' } });
    assert.deepEqual(r.response, { ok: true, httpStatus: 200, waMessageId: WAMID, messageStatus: 'held_for_quality_assessment', body: JSON.parse(next.body) });
    assert.match(r.message, /holding it back/);
    assert.doesNotMatch(JSON.stringify(r), /EAAG-test-token-secret/, 'never the access token');
  });
  test('no answer in time: MetaTimeoutError, logged as a timeout with messageSent unknown', async () => {
    next = { status: 200, body: '', hang: true };
    await assert.rejects(wa.sendText(account, '971500000000', 'hi'), (e: Error) => e.name === 'MetaTimeoutError');
    const r = await last('whatsapp.send');
    assert.deepEqual([r.level, r.outcome, r.messageSent, r.errorCode], ['ERROR', 'timeout', null, 'META_TIMEOUT']);
    assert.ok(r.durationMs! >= 250, 'it waited for the time limit');
  });
  test("an answer that isn't JSON (an error page): reported with its status and type, never the body", async () => {
    next = { status: 502, body: '<html>Bad Gateway 971500000000</html>', type: 'text/html' };
    await assert.rejects(wa.sendText(account, '971500000000', 'hi'), (e: Error) => e.name === 'MetaResponseError');
    const r = await last('whatsapp.send');
    assert.deepEqual([r.outcome, r.messageSent, r.errorCode], ['unclear', null, 502]);
    assert.match(r.message, /HTTP 502 with a response that isn't JSON \(text\/html, \d+ bytes\)/);
    assert.doesNotMatch(JSON.stringify(r), /Bad Gateway/, "an answer that isn't JSON is described, never stored");
  });
  test('HTTP 200 without a message id: not taken as sent', async () => {
    next = { status: 200, body: JSON.stringify({ messages: [] }) };
    await assert.rejects(wa.sendText(account, '971500000000', 'hi'), /without a message id/);
    assert.equal((await last('whatsapp.send')).messageSent, null);
  });
});

describe('delivery statuses (webhook)', () => {
  const sentAt = new Date('2026-10-26T11:03:30.000Z');
  const msg = { id: 'm1', conversationId: 'c1', status: 'sent', type: 'text', waMessageId: WAMID, createdAt: sentAt };
  const ts = String(Math.floor(sentAt.getTime() / 1000) + 3); // 3 s later
  test("delivered: customerReceived 1, Meta's exact time and how long after the send", async () => {
    messages.logStatus('w1', msg, { id: WAMID, status: 'delivered', timestamp: ts, recipient_id: '971500000000', pricing: { billable: true, category: 'service', pricing_model: 'PMP' } });
    const r = await last('message.status');
    assert.deepEqual([r.level, r.deliveryStatus, r.customerReceived, r.messageSent, r.previousStatus], ['SUCCESS', 'delivered', 1, 1, 'sent']);
    const d = r.data as Record<string, unknown>;
    assert.deepEqual([d.metaTime, d.msSinceCreated, d.billable, d.conversationCategory], ['2026-10-26T11:03:33.000Z', 3000, true, 'service']);
    assert.match(r.message, /at 2026-10-26T11:03:33\.000Z \(3\.0 s after it was sent\); the customer received it/);
    assert.deepEqual([r.waMessageId, d.recipientId], [WAMID, '971500000000']);
  });
  test('sent: not yet confirmed (customerReceived null)', async () => {
    messages.logStatus('w1', { ...msg, status: 'pending' }, { id: WAMID, status: 'sent', timestamp: ts });
    assert.equal((await last('message.status')).customerReceived, null);
  });
  test("failed: customerReceived 0, every one of Meta's errors with its documented meaning", async () => {
    messages.logStatus('w1', msg, {
      id: WAMID,
      status: 'failed',
      timestamp: ts,
      errors: [
        { code: 131049, title: 'This message was not delivered to maintain healthy ecosystem engagement.', error_data: { details: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.' } },
        { code: 999123, title: 'Some new error' },
      ],
    });
    const r = await last('message.status');
    assert.deepEqual([r.level, r.deliveryStatus, r.customerReceived, r.errorCode], ['ERROR', 'failed', 0, 131049]);
    assert.match(r.errorDetails!, /Meta documents code 131049 as: Meta chose not to deliver/);
    assert.match(r.errorDetails!, /"Some new error" \(code 999123\)\. Code 999123 has no documented meaning/);
  });
  test('failed with no error from Meta: says so, never guesses a reason', async () => {
    messages.logStatus('w1', msg, { id: WAMID, status: 'failed', timestamp: ts });
    const r = await last('message.status');
    assert.equal(r.errorDetails, 'Meta reported the message as failed but gave no error code or reason');
    assert.equal(r.errorCode, null);
  });
});

describe('reading the logs back (trace and audit)', () => {
  const json = (o: Record<string, unknown>) => JSON.stringify({ logId: null, timestamp: '2026-10-26T15:00:00.000+04:00', level: 'SUCCESS', messageSent: null, ...o });
  test('both formats parse; an older raw wamid becomes its reference', () => {
    const text = trace.parseLogLine(`2026-10-26 12:59:21.592 +04:00 SUCCESS message.sent Sent a message (template) | req=r1 workspace=w data={"conversationId":"c1","messageId":"m9","type":"template"}`)!;
    assert.deepEqual([text.format, text.event, text.messageId, text.requestId, text.newStatus], ['text', 'message.sent', 'm9', 'r1', 'sent']);
    const old = trace.parseLogLine(JSON.stringify({ timestamp: 't', level: 'SUCCESS', event: 'message.status', messageId: 'm9', waMessageId: WAMID }))!;
    assert.equal(old.waMessageRef, logging.waRef(WAMID));
    assert.equal(old.tracked, false);
    assert.equal(trace.parseLogLine('not a log line'), null);
  });
  test('accepted then delivered then read; refused; timed out; statuses without a send; a reaction is no message', () => {
    const ref = logging.waRef(WAMID);
    const lines = [
      json({ logId: 1, event: 'whatsapp.send', messageId: 'a', waMessageRef: ref, requestId: 'r1' }),
      json({ logId: 2, event: 'message.sent', messageId: 'a', waMessageRef: ref, messageSent: 1, deliveryStatus: 'sent' }),
      json({ logId: 3, event: 'message.status', messageId: 'a', waMessageRef: ref, messageSent: 1, deliveryStatus: 'delivered', customerReceived: 1 }),
      json({ logId: 4, event: 'message.status', waMessageRef: ref, messageSent: 1, deliveryStatus: 'read', customerReceived: 1 }),
      json({ logId: 5, event: 'message.send_failed', messageId: 'b', level: 'ERROR', outcome: 'refused', messageSent: 0, errorCode: 131047, errorDetails: 'Re-engagement message' }),
      json({ logId: 6, event: 'message.send_failed', messageId: 'c', level: 'ERROR', outcome: 'timeout', messageSent: null, errorCode: 'META_TIMEOUT' }),
      json({ logId: 7, event: 'message.status_unmatched', waMessageRef: 'wa:ffffffffffffffff', deliveryStatus: 'failed', errorDetails: 'Meta reported the message as failed but gave no error code or reason' }),
      json({ logId: 8, event: 'whatsapp.send', waMessageRef: 'wa:eeeeeeeeeeeeeeee' }), // a reaction
    ].map((l, i) => trace.parseLogLine(l, 'f', i + 1)!);
    const traces = trace.buildTraces(lines);
    assert.equal(traces.length, 4);
    const a = trace.findTrace(lines, 'a')!;
    assert.deepEqual([a.send, a.deliveryStatus, a.customerReceived, a.entries.length], ['accepted', 'read', 1, 4]);
    assert.equal(trace.findTrace(lines, WAMID)?.messageId, 'a', 'found by its wamid too');
    const b = trace.findTrace(lines, 'b')!;
    assert.deepEqual([b.send, b.customerReceived, b.failureReasons], ['refused', 0, ['Re-engagement message']]);
    const c = trace.findTrace(lines, 'c')!;
    assert.deepEqual([c.send, c.customerReceived], ['unknown', null]);
    assert.match(c.gaps.join(), /whether it was sent is unknown/);
    const orphan = trace.findTrace(lines, 'wa:ffffffffffffffff')!;
    assert.deepEqual([orphan.send, orphan.customerReceived], ['not logged', 0]);
    assert.match(orphan.gaps.join(), /Meta gave no reason/);
  });
  test('the audit counts outcomes and finds customer data left in clear by older entries', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'audit-'));
    try {
      await writeFile(
        path.join(folder, '2026-10-26.log'),
        [
          json({ logId: 1, event: 'message.sent', messageId: 'a', messageSent: 1, deliveryStatus: 'sent' }),
          JSON.stringify({ timestamp: 't', level: 'SUCCESS', event: 'message.status', messageId: 'a', newStatus: 'delivered', waMessageId: WAMID }),
          json({ logId: 3, event: 'message.sent', messageId: 'b', messageSent: 1, deliveryStatus: 'sent' }),
        ].join('\n') + '\n',
      );
      const a = trace.audit(trace.logFiles(folder));
      assert.deepEqual([a.lines, a.messages, a.confirmedReceived, a.unconfirmed], [3, 2, 1, 1]);
      assert.equal(a.privacy.rawWamid, 1);
      assert.equal(a.gaps['Meta accepted it, but no delivery status webhook is in these logs: delivery is not confirmed'], 1);
      env.logCustomerData = false; // printing follows the setting
      try {
        assert.doesNotMatch(trace.describeEntry(trace.parseLogLine(`{"timestamp":"t","level":"ERROR","event":"x","message":"to ${WAMID} +971500000000"}`)!), /wamid\.|971500000000/);
      } finally {
        env.logCustomerData = true;
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
