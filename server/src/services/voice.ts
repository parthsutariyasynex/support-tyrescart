import { AppError } from './errors.js';

// Voice notes recorded in the browser. WhatsApp shows a recording as a voice note only when it is OGG audio with the
// Opus codec. Firefox records that directly; Chrome and Edge record Opus inside WebM, which is repackaged here into
// OGG without re-encoding (the Opus packets are copied as they are); Safari records MP4/AAC, which WhatsApp accepts
// as a regular audio message.

export const VOICE_MAX_BYTES = 16 * 1024 * 1024; // WhatsApp's limit for audio

const startsWith = (b: Buffer, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);
const EBML = [0x1a, 0x45, 0xdf, 0xa3];
const OGGS = [0x4f, 0x67, 0x67, 0x53];
const FTYP = [0x66, 0x74, 0x79, 0x70]; // "ftyp" at byte 4 of an MP4

// The recording as WhatsApp should get it: OGG/Opus (from OGG or WebM) or MP4 audio. Checked from the bytes.
export function prepareVoice(bytes: Buffer | undefined, mime: string | undefined) {
  if (!bytes?.length) throw new AppError('The recording is empty', 400, 'BAD_USER_INPUT');
  if (bytes.length > VOICE_MAX_BYTES) throw new AppError('Voice messages can be up to 16 MB', 413, 'TOO_LARGE');
  const type = (mime ?? '').toLowerCase().split(';')[0].trim();
  const bad = () => new AppError("That recording isn't a supported audio file", 415, 'UNSUPPORTED_MEDIA');
  if (type === 'audio/ogg') {
    if (!startsWith(bytes, OGGS)) throw bad();
    return { bytes, mime: 'audio/ogg', ext: 'ogg', durationMs: oggDurationMs(bytes) };
  }
  if (type === 'audio/webm') {
    if (!startsWith(bytes, EBML)) throw bad();
    const ogg = webmOpusToOgg(bytes);
    return { bytes: ogg.bytes, mime: 'audio/ogg', ext: 'ogg', durationMs: ogg.durationMs };
  }
  if (type === 'audio/mp4' || type === 'audio/x-m4a') {
    if (!startsWith(bytes, FTYP, 4)) throw bad();
    return { bytes, mime: 'audio/mp4', ext: 'm4a', durationMs: null };
  }
  throw bad();
}

// --- WebM (Matroska) reading: just enough to get the Opus track's setup and packets

const ID = {
  Segment: 0x18538067,
  Cluster: 0x1f43b675,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  BlockGroup: 0xa0,
  TrackNumber: 0xd7,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Channels: 0x9f,
  Audio: 0xe1,
  SimpleBlock: 0xa3,
  Block: 0xa1,
};
// Containers whose contents are read in place (they may have an "unknown" size while recording live)
const DESCEND = new Set([ID.Segment, ID.Cluster, ID.Tracks, ID.TrackEntry, ID.BlockGroup, ID.Audio]);

// Element ids keep their length marker; sizes drop it. All ones = unknown size.
function readVint(b: Buffer, pos: number, keepMarker: boolean) {
  const first = b[pos];
  if (first === undefined) throw new Error('Unexpected end of file');
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8) throw new Error('Invalid element');
  if (pos + len > b.length) throw new Error('Unexpected end of file');
  let value = keepMarker ? first : first & (0xff >> len);
  let allOnes = value === (0xff >> len);
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[pos + i];
    if (b[pos + i] !== 0xff) allOnes = false;
  }
  return { value, len, unknown: !keepMarker && allOnes };
}

export function readWebmOpus(b: Buffer) {
  let opusTrack: number | null = null;
  let current: { number?: number; codec?: string; priv?: Buffer; channels?: number } = {};
  const tracks: (typeof current)[] = [];
  const blocks: { track: number; data: Buffer }[] = [];
  let pos = 0;
  while (pos < b.length) {
    let id;
    let size;
    try {
      id = readVint(b, pos, true);
      size = readVint(b, pos + id.len, false);
    } catch {
      break; // a recording cut short: keep what was read
    }
    const start = pos + id.len + size.len;
    if (DESCEND.has(id.value)) {
      if (id.value === ID.TrackEntry) {
        current = {};
        tracks.push(current);
      }
      pos = start;
      continue;
    }
    if (size.unknown) throw new AppError("That recording isn't a supported audio file", 415, 'UNSUPPORTED_MEDIA');
    const end = start + size.value;
    if (end > b.length) break; // last element cut off
    const data = b.subarray(start, end);
    switch (id.value) {
      case ID.TrackNumber:
        current.number = data.reduce((n, x) => n * 256 + x, 0);
        break;
      case ID.CodecID:
        current.codec = data.toString('latin1');
        break;
      case ID.CodecPrivate:
        current.priv = Buffer.from(data);
        break;
      case ID.Channels:
        current.channels = data.reduce((n, x) => n * 256 + x, 0);
        break;
      case ID.SimpleBlock:
      case ID.Block: {
        const track = readVint(data, 0, false);
        const flags = data[track.len + 2];
        if (flags & 0x06) throw new AppError('This recording format isn’t supported (laced audio)', 415, 'UNSUPPORTED_MEDIA');
        blocks.push({ track: track.value, data: Buffer.from(data.subarray(track.len + 3)) });
        break;
      }
    }
    pos = end;
  }
  const opus = tracks.find((t) => t.codec === 'A_OPUS');
  if (!opus?.number) throw new AppError("That recording isn't Opus audio", 415, 'UNSUPPORTED_MEDIA');
  opusTrack = opus.number;
  const head = opus.priv && opus.priv.subarray(0, 8).toString('latin1') === 'OpusHead' ? opus.priv : opusHead(opus.channels ?? 1);
  return { head, packets: blocks.filter((x) => x.track === opusTrack && x.data.length).map((x) => x.data) };
}

// Default Opus setup header (RFC 7845): version 1, channels, 312 samples pre-skip, 48 kHz, no gain, mapping 0
function opusHead(channels: number) {
  const h = Buffer.alloc(19);
  h.write('OpusHead', 0, 'latin1');
  h[8] = 1;
  h[9] = channels;
  h.writeUInt16LE(312, 10);
  h.writeUInt32LE(48000, 12);
  return h;
}

// Samples (at 48 kHz) in one Opus packet, from its TOC byte (RFC 6716, 3.1)
export function opusPacketSamples(p: Buffer) {
  const toc = p[0];
  const config = toc >> 3;
  const frameUs =
    config < 12 ? [10000, 20000, 40000, 60000][config % 4] : config < 16 ? [10000, 20000][config % 2] : [2500, 5000, 10000, 20000][config % 4];
  const code = toc & 3;
  const frames = code === 0 ? 1 : code === 3 ? (p[1] ?? 0) & 0x3f : 2;
  return (frameUs / 1000) * 48 * frames;
}

// --- OGG writing (RFC 3533 pages, RFC 7845 Opus mapping)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();
export function oggCrc(b: Buffer) {
  let crc = 0;
  for (const x of b) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ x) & 0xff]) >>> 0;
  return crc >>> 0;
}

function oggPage(packets: Buffer[], granule: bigint, serial: number, seq: number, flags: number) {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
  }
  const header = Buffer.alloc(27 + lacing.length);
  header.write('OggS', 0, 'latin1');
  header[4] = 0;
  header[5] = flags;
  header.writeBigInt64LE(granule, 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(seq, 18);
  header.writeUInt32LE(0, 22);
  header[26] = lacing.length;
  lacing.forEach((v, i) => (header[27 + i] = v));
  const page = Buffer.concat([header, ...packets]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

export function webmOpusToOgg(webm: Buffer) {
  const { head, packets } = readWebmOpus(webm);
  if (!packets.length) throw new AppError('The recording has no sound', 400, 'BAD_USER_INPUT');
  const serial = (Math.random() * 0xffffffff) >>> 0;
  const vendor = Buffer.from('support-tyrescart');
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write('OpusTags', 0, 'latin1');
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length);

  const pages = [oggPage([head], 0n, serial, 0, 0x02), oggPage([tags], 0n, serial, 1, 0)];
  let seq = 2;
  let granule = 0n;
  let batch: Buffer[] = [];
  let segments = 0;
  const flush = (last: boolean) => {
    pages.push(oggPage(batch, granule, serial, seq++, last ? 0x04 : 0));
    batch = [];
    segments = 0;
  };
  packets.forEach((p, i) => {
    const segs = Math.floor(p.length / 255) + 1;
    if (batch.length && (segments + segs > 255 || batch.length >= 50)) flush(false);
    batch.push(p);
    segments += segs;
    granule += BigInt(opusPacketSamples(p));
    if (i === packets.length - 1) flush(true);
  });
  const preSkip = head.readUInt16LE(10);
  return { bytes: Buffer.concat(pages), durationMs: Math.max(0, Math.round((Number(granule) - preSkip) / 48)) };
}

// Length of an OGG/Opus file: the last page's granule position, minus the pre-skip, at 48 kHz (null if unreadable)
export function oggDurationMs(b: Buffer) {
  const at = b.lastIndexOf(Buffer.from('OggS'));
  const headAt = b.indexOf(Buffer.from('OpusHead'));
  if (at < 0 || at + 14 > b.length || headAt < 0) return null;
  const granule = Number(b.readBigInt64LE(at + 6));
  const preSkip = b.readUInt16LE(headAt + 10);
  return granule > 0 ? Math.max(0, Math.round((granule - preSkip) / 48)) : null;
}
