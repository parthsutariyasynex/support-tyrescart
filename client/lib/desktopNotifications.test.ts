// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { customerMessageNotice } from './desktopNotifications';

const ev = (message: Partial<Parameters<typeof customerMessageNotice>[0]['message']>, contact: { name?: string | null; waId?: string } | null = { name: 'Alice Patel', waId: '971501234567' }) => ({
  conversation: { contact },
  message: { id: 'm1', conversationId: 'c1', direction: 'in', type: 'text', body: 'Do you have 205/55 R16?', ...message },
});

describe('desktop notification for a new customer message', () => {
  test("the customer's name and the message; one per chat (tag); clicking opens that chat", () => {
    assert.deepEqual(customerMessageNotice(ev({}), new Set()), { title: 'Alice Patel', body: 'Do you have 205/55 R16?', tag: 'message-c1', conversationId: 'c1' });
  });
  test('only new incoming messages: not ours, not deleted, not the same message twice', () => {
    const seen = new Set<string>();
    assert.equal(customerMessageNotice(ev({ direction: 'out' }), seen), null);
    assert.equal(customerMessageNotice(ev({ deletedAt: '2026-10-22T10:00:00Z' }), seen), null);
    assert.ok(customerMessageNotice(ev({}), seen));
    assert.equal(customerMessageNotice(ev({}), seen), null, 'the same message again (e.g. after a reconnect)');
    assert.ok(customerMessageNotice(ev({ id: 'm2' }), seen), 'the next message');
  });
  test('only the last 200 messages are remembered', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 250; i++) customerMessageNotice(ev({ id: `m${i}` }), seen);
    assert.equal(seen.size, 200);
    assert.ok(!seen.has('m0') && seen.has('m249'));
  });
  test('files are described, long text is shortened, no name falls back to the number', () => {
    assert.equal(customerMessageNotice(ev({ type: 'image', body: '[image]' }), new Set())!.body, '📷 Photo');
    assert.equal(customerMessageNotice(ev({ type: 'image', body: 'This tyre' }), new Set())!.body, '📷 This tyre');
    assert.equal(customerMessageNotice(ev({ type: 'document', body: '', mediaName: 'invoice.pdf' }), new Set())!.body, '📄 invoice.pdf');
    assert.equal(customerMessageNotice(ev({ type: 'voice', body: '' }), new Set())!.body, '🎤 Voice message');
    assert.equal(customerMessageNotice(ev({ body: '  ' }), new Set())!.body, 'New message');
    const long = customerMessageNotice(ev({ body: `Hello\n\n${'a'.repeat(200)}` }), new Set())!.body;
    assert.equal(long.length, 120);
    assert.ok(long.startsWith('Hello a') && long.endsWith('…'));
    assert.equal(customerMessageNotice(ev({}, { name: '', waId: '971501234567' }), new Set())!.title, '+971501234567');
    assert.equal(customerMessageNotice(ev({}, null), new Set())!.title, 'New message');
  });
});
