// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { forwardBlocked, forwardKind } from './forward';

const m = (over: Partial<Parameters<typeof forwardKind>[0]>) => ({ type: 'text', body: 'Do you have 205/55 R16?', mediaMime: null, deletedAt: null, ...over });

describe('forwarding: what can be forwarded', () => {
  test('text, JPEG/PNG photos, documents and voice notes; their file type decides', () => {
    assert.equal(forwardKind(m({})), 'text');
    assert.equal(forwardKind(m({ type: 'template', body: 'Hello Alice Patel 👋, I just wanted to follow up' })), 'text');
    assert.equal(forwardKind(m({ type: 'image', body: '[image]', mediaMime: 'image/jpeg' })), 'image');
    assert.equal(forwardKind(m({ type: 'image', body: 'This tyre', mediaMime: 'image/png' })), 'image');
    assert.equal(forwardKind(m({ type: 'document', body: '', mediaMime: 'application/pdf' })), 'document');
    assert.equal(forwardKind(m({ type: 'voice', body: '', mediaMime: 'audio/ogg; codecs=opus' })), 'voice');
  });
  test("not what this app can't send, nor deleted or empty messages", () => {
    assert.equal(forwardKind(m({ type: 'image', mediaMime: 'image/webp' })), null);
    assert.equal(forwardKind(m({ type: 'document', mediaMime: 'application/zip' })), null);
    assert.equal(forwardKind(m({ type: 'video', mediaMime: 'video/mp4' })), null);
    assert.equal(forwardKind(m({ type: 'sticker', mediaMime: 'image/webp' })), null);
    assert.equal(forwardKind(m({ type: 'audio', mediaMime: 'audio/mpeg' })), null);
    assert.equal(forwardKind(m({ type: 'voice', mediaMime: null })), null, 'a voice note not downloaded yet');
    assert.equal(forwardKind(m({ deletedAt: '2026-10-22T10:00:00Z' })), null);
    assert.equal(forwardKind(m({ body: '   ' })), null);
    assert.equal(forwardKind(m({ type: 'template', body: '[template] order_ready' })), null, 'an old template placeholder');
  });
});

describe('forwarding: which chats can take it now', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  test('open chats inside the 24-hour window; closed chats and closed windows are explained', () => {
    assert.equal(forwardBlocked({ status: 'open', lastInboundAt: '2026-10-22T08:00:00Z' }, now), '');
    assert.equal(forwardBlocked({ status: 'snoozed', lastInboundAt: '2026-10-22T08:00:00Z' }, now), '');
    assert.equal(forwardBlocked({ status: 'closed', lastInboundAt: '2026-10-22T08:00:00Z' }, now), 'Closed: reopen it to write');
    assert.match(forwardBlocked({ status: 'open', lastInboundAt: '2026-10-21T11:59:00Z' }, now), /24-hour window closed/);
    assert.match(forwardBlocked({ status: 'open', lastInboundAt: null }, now), /24-hour window closed/);
  });
});
