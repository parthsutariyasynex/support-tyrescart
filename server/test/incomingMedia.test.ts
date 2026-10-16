// Customer media: reading it from WhatsApp's webhook and downloading it (no database; WhatsApp is faked)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { describe as describeMessage, parseWebhookMessage } from '../src/messages.js';
import { cleanIncomingName, cleanMime } from '../src/services/incomingMedia.js';
import { downloadMedia } from '../src/whatsapp.js';

describe('customer media in the webhook', () => {
  test('image with caption, document with its name, voice note, sticker, video', () => {
    assert.deepEqual(describeMessage({ type: 'image', image: { id: 'M1', mime_type: 'image/jpeg', caption: 'my tyre' } }), { type: 'image', body: 'my tyre', media: { id: 'M1', mime: 'image/jpeg' } });
    assert.deepEqual(describeMessage({ type: 'document', document: { id: 'M2', mime_type: 'application/pdf', filename: 'invoice.pdf' } }), {
      type: 'document',
      body: '[document]',
      media: { id: 'M2', mime: 'application/pdf', filename: 'invoice.pdf' },
    });
    assert.equal(describeMessage({ type: 'audio', audio: { id: 'M3', mime_type: 'audio/ogg; codecs=opus', voice: true } }).type, 'voice');
    assert.equal(describeMessage({ type: 'audio', audio: { id: 'M4', mime_type: 'audio/mpeg' } }).type, 'audio');
    assert.deepEqual(describeMessage({ type: 'sticker', sticker: { id: 'M5', mime_type: 'image/webp' } }).media, { id: 'M5', mime: 'image/webp' });
    assert.equal(describeMessage({ type: 'video', video: { id: 'M6' } }).body, '[video]');
    // Missing media object: a placeholder, never a crash
    assert.deepEqual(describeMessage({ type: 'image' }), { type: 'image', body: '[image]' });
    assert.equal(parseWebhookMessage({ from: '971500000001', id: 'wamid.x', type: 'image', image: { id: 'M7' } }).media?.id, 'M7');
  });
  test('types and names are cleaned', () => {
    assert.equal(cleanMime('audio/ogg; codecs=opus'), 'audio/ogg');
    assert.equal(cleanMime('IMAGE/JPEG'), 'image/jpeg');
    assert.equal(cleanMime('<script>'), 'application/octet-stream');
    assert.equal(cleanMime(undefined), 'application/octet-stream');
    assert.equal(cleanIncomingName('../../etc/passwd'), '.. .. etc passwd');
    assert.equal(cleanIncomingName('  '), null);
    assert.equal(cleanIncomingName(42), null);
  });
});

describe('downloading media from WhatsApp', () => {
  const account = { phoneNumberId: 'pn', accessToken: 'TOKEN' };
  const fake = (info: object, file: Buffer | null, infoStatus = 200) => {
    const calls: { url: string; auth: string | null }[] = [];
    const impl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
      if (String(url).includes('graph.facebook.com')) return new Response(JSON.stringify(info), { status: infoStatus });
      return file ? new Response(new Uint8Array(file), { status: 200 }) : new Response('nope', { status: 404 });
    }) as typeof fetch;
    return { impl, calls };
  };
  test('asks for the URL, then the file, both with the token', async () => {
    const f = fake({ url: 'https://lookaside.fbsbx.com/x', mime_type: 'image/jpeg', file_size: 3 }, Buffer.from([1, 2, 3]));
    const r = await downloadMedia(account, 'MEDIA1', 1000, f.impl);
    assert.deepEqual([...r.bytes], [1, 2, 3]);
    assert.equal(r.mime, 'image/jpeg');
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls[0].url.endsWith('/MEDIA1'));
    assert.ok(f.calls.every((c) => c.auth === 'Bearer TOKEN'));
  });
  test('refuses too large, reports WhatsApp errors and failed downloads', async () => {
    await assert.rejects(downloadMedia(account, 'M', 10, fake({ url: 'u', file_size: 11 }, Buffer.alloc(11)).impl), /too large/);
    await assert.rejects(downloadMedia(account, 'M', 10, fake({ url: 'u' }, Buffer.alloc(11)).impl), /too large/); // size not given up front
    await assert.rejects(downloadMedia(account, 'M', 10, fake({ error: { message: 'Invalid media id' } }, null, 400).impl), /Invalid media id/);
    await assert.rejects(downloadMedia(account, 'M', 10, fake({ url: 'u' }, null).impl), /download failed \(404\)/);
  });
});
