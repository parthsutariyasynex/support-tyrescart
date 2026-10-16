// Voice notes: repackaging a real Chrome recording (WebM/Opus) into OGG/Opus for WhatsApp (no database)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { oggCrc, oggDurationMs, opusPacketSamples, prepareVoice, readWebmOpus, webmOpusToOgg } from '../src/services/voice.js';

const webm = readFileSync(new URL('./fixtures/voice-chrome.webm', import.meta.url)); // 2 s, recorded by Chrome's MediaRecorder

function pages(ogg: Buffer) {
  const out: { flags: number; granule: bigint; seq: number; crcOk: boolean; packets: Buffer[] }[] = [];
  let pos = 0;
  while (pos < ogg.length) {
    assert.equal(ogg.subarray(pos, pos + 4).toString('latin1'), 'OggS');
    const n = ogg[pos + 26];
    const lacing = [...ogg.subarray(pos + 27, pos + 27 + n)];
    const len = 27 + n + lacing.reduce((a, b) => a + b, 0);
    const page = Buffer.from(ogg.subarray(pos, pos + len));
    const crc = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    const packets: Buffer[] = [];
    let at = pos + 27 + n;
    let cur = 0;
    for (const l of lacing) {
      cur += l;
      if (l < 255) {
        packets.push(ogg.subarray(at, at + cur));
        at += cur;
        cur = 0;
      }
    }
    out.push({ flags: ogg[pos + 5], granule: ogg.readBigInt64LE(pos + 6), seq: ogg.readUInt32LE(pos + 18), crcOk: oggCrc(page) === crc, packets });
    pos += len;
  }
  return out;
}

describe('voice notes: WebM/Opus to OGG/Opus', () => {
  test('reads the Opus setup and packets from Chrome\'s recording', () => {
    const r = readWebmOpus(webm);
    assert.equal(r.head.subarray(0, 8).toString('latin1'), 'OpusHead');
    assert.ok(r.packets.length > 10);
    assert.ok(r.packets.every((p) => opusPacketSamples(p) > 0));
  });

  test('writes valid OGG pages: header, tags, audio; CRCs; increasing granule; end marker; same packets', () => {
    const { bytes, durationMs } = webmOpusToOgg(webm);
    const ps = pages(bytes);
    assert.ok(ps.length >= 3);
    assert.ok(ps.every((p) => p.crcOk));
    assert.deepEqual(ps.map((p) => p.seq), ps.map((_, i) => i));
    assert.equal(ps[0].flags, 0x02); // first page
    assert.equal(ps[0].packets[0].subarray(0, 8).toString('latin1'), 'OpusHead');
    assert.equal(ps[1].packets[0].subarray(0, 8).toString('latin1'), 'OpusTags');
    assert.equal(ps.at(-1)!.flags & 0x04, 0x04); // last page
    for (let i = 3; i < ps.length; i++) assert.ok(ps[i].granule > ps[i - 1].granule);
    const audio = ps.slice(2).flatMap((p) => p.packets);
    assert.deepEqual(audio.map((p) => p.toString('hex')), readWebmOpus(webm).packets.map((p) => p.toString('hex'))); // copied as-is
    assert.ok(durationMs > 1800 && durationMs < 2200, String(durationMs)); // ~2 s
    assert.equal(oggDurationMs(bytes), durationMs);
  });

  test('Opus packet lengths from the TOC byte', () => {
    assert.equal(opusPacketSamples(Buffer.from([0xfc])), 960); // CELT 20 ms, 1 frame
    assert.equal(opusPacketSamples(Buffer.from([0x18 | 0])), 2880); // SILK 60 ms
    assert.equal(opusPacketSamples(Buffer.from([0xfd])), 1920); // 2 frames of 20 ms
    assert.equal(opusPacketSamples(Buffer.from([0xf3, 0x03])), 3 * 480); // CELT 10 ms (config 30) x3 (code 3)
    assert.equal(opusPacketSamples(Buffer.from([0xfb, 0x03])), 3 * 960); // CELT 20 ms (config 31) x3
  });

  test('prepareVoice: WebM becomes OGG; OGG passes through; MP4 accepted; anything else refused', () => {
    const v = prepareVoice(webm, 'audio/webm;codecs=opus');
    assert.deepEqual([v.mime, v.ext], ['audio/ogg', 'ogg']);
    const again = prepareVoice(v.bytes, 'audio/ogg; codecs=opus');
    assert.ok(again.bytes.equals(v.bytes));
    assert.equal(again.durationMs, v.durationMs);
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A '), Buffer.alloc(16)]);
    assert.deepEqual(prepareVoice(mp4, 'audio/mp4').mime, 'audio/mp4');
    assert.throws(() => prepareVoice(Buffer.from('not audio'), 'audio/webm'), /supported audio/);
    assert.throws(() => prepareVoice(Buffer.from('OggS'), 'audio/mpeg'), /supported audio/);
    assert.throws(() => prepareVoice(Buffer.alloc(0), 'audio/ogg'), /empty/);
    assert.throws(() => prepareVoice(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(16 * 1024 * 1024)]), 'audio/ogg'), /16 MB/);
    // A WebM with no Opus track
    assert.throws(() => prepareVoice(webm.subarray(0, 40), 'audio/webm'), /Opus/);
  });
});
