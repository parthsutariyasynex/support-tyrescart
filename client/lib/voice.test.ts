import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatDuration, micErrorMessage, pickRecordingType } from './voice';

describe('voice notes', () => {
  test('recording format: OGG, else WebM/Opus, else MP4, else none', () => {
    assert.equal(pickRecordingType((t) => t === 'audio/ogg;codecs=opus' || t === 'audio/webm;codecs=opus'), 'audio/ogg;codecs=opus');
    assert.equal(pickRecordingType((t) => t === 'audio/webm;codecs=opus' || t === 'audio/mp4'), 'audio/webm;codecs=opus'); // Chrome
    assert.equal(pickRecordingType((t) => t === 'audio/mp4'), 'audio/mp4'); // Safari
    assert.equal(pickRecordingType(() => false), null);
  });
  test('durations like WhatsApp', () => {
    assert.deepEqual([0, 999, 7000, 65_400, 720_000].map(formatDuration), ['0:00', '0:00', '0:07', '1:05', '12:00']);
    assert.equal(formatDuration(Number.POSITIVE_INFINITY), '0:00');
  });
  test('microphone errors in plain words', () => {
    assert.match(micErrorMessage({ name: 'NotAllowedError' }), /blocked/);
    assert.match(micErrorMessage({ name: 'NotFoundError' }), /No microphone/);
    assert.match(micErrorMessage({ name: 'NotReadableError' }), /another app/);
    assert.match(micErrorMessage({ name: 'NoMediaDevices' }), /https/);
    assert.match(micErrorMessage(new Error('x')), /Couldn't start recording/);
  });
});
