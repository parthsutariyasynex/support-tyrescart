import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { geolocationProblem, isIncomingLiveLocation, liveLinkOf, locationPreview, mapLinks, parseLocationBody, prefersAppleMaps, tilesAround, worldPixel } from './location';
import { isLiveNow, metresBetween, sendDelay, shouldSend } from './liveSharing';
import { filePreview } from './media';

describe('location messages (same format as the server writes)', () => {
  test('reads name, address and exact coordinates', () => {
    assert.deepEqual(parseLocationBody('📍 TyresCart Al Quoz\nAl Quoz 3, Dubai\nhttps://maps.google.com/?q=25.123457,55.234568'), {
      latitude: 25.123457,
      longitude: 55.234568,
      name: 'TyresCart Al Quoz',
      address: 'Al Quoz 3, Dubai',
    });
    assert.deepEqual(parseLocationBody('https://maps.google.com/?q=-33.9,-70.6'), { latitude: -33.9, longitude: -70.6, name: null, address: null });
    for (const body of ['[location]', 'https://maps.google.com/?q=95,1', 'https://other.test/?q=1,2', 'see https://maps.google.com/?q=1,2 here']) assert.equal(parseLocationBody(body), null, body);
  });
  test('chat list and quote lines', () => {
    assert.equal(locationPreview({ type: 'location', body: '📍 TyresCart\nhttps://maps.google.com/?q=25,55' }), '📍 TyresCart');
    assert.equal(locationPreview({ type: 'location', body: 'Al Quoz 3\nhttps://maps.google.com/?q=25,55' }), '📍 Al Quoz 3');
    assert.equal(locationPreview({ type: 'location', body: '[location]' }), '📍 Location');
    assert.equal(locationPreview({ type: 'location', body: '[live location]' }), '📍 Live location');
    assert.equal(locationPreview({ type: 'live_location', body: 'whatever' }), '📍 Live location');
    assert.equal(locationPreview({ type: 'text', body: 'hi' }), null);
    assert.equal(filePreview({ type: 'location', body: '📍 Dubai Mall\nhttps://maps.google.com/?q=25.19,55.27' }), '📍 Dubai Mall');
    assert.equal(isIncomingLiveLocation({ type: 'location', body: '[live location]' }), true);
  });
  test('the live link inside a live location message', () => {
    assert.equal(liveLinkOf('📍 Live location: … until 14:30.\nFollow it on the map: https://support.tyrescart.ae/live/abcdefghijklmnopqrstuvwx'), 'https://support.tyrescart.ae/live/abcdefghijklmnopqrstuvwx');
    assert.equal(liveLinkOf('no link here'), null);
  });
});

describe('opening the exact point in Google Maps / Apple Maps', () => {
  test('standard links with the coordinates (and a name for Apple Maps)', () => {
    assert.deepEqual(mapLinks({ latitude: 25.123457, longitude: 55.234568, name: 'Tyre & Co' }), {
      google: 'https://www.google.com/maps/search/?api=1&query=25.123457%2C55.234568',
      apple: 'https://maps.apple.com/?ll=25.123457%2C55.234568&q=Tyre%20%26%20Co',
    });
  });
  test('Apple devices prefer Apple Maps', () => {
    assert.equal(prefersAppleMaps('MacIntel', ''), true);
    assert.equal(prefersAppleMaps('iPhone', ''), true);
    assert.equal(prefersAppleMaps('Win32', 'Mozilla/5.0 (Windows NT 10.0)'), false);
    assert.equal(prefersAppleMaps('Linux armv8l', 'Mozilla/5.0 (Linux; Android 14)'), false);
  });
});

describe('map picture (tiles, Web Mercator)', () => {
  test('the world map in pixels', () => {
    assert.deepEqual(worldPixel(0, 0, 0), { x: 128, y: 128 });
    const p = worldPixel(0, 180, 1);
    assert.equal(p.x, 512);
  });
  test('tiles covering the picture, centred on the point', () => {
    const tiles = tilesAround(25.2048, 55.2708, 15, 260, 140);
    assert.ok(tiles.length >= 2 && tiles.length <= 4);
    for (const t of tiles) assert.match(t.url, /^https:\/\/tile\.openstreetmap\.org\/15\/\d+\/\d+\.png$/);
    // The point is in the middle: some tile covers (130, 70)
    assert.ok(tiles.some((t) => t.left <= 130 && t.left + 256 > 130 && t.top <= 70 && t.top + 256 > 70));
    // Near the date line, tile numbers wrap round
    for (const t of tilesAround(0, 179.999, 2, 260, 140)) assert.match(t.url, /\/2\/[0-3]\/\d\.png$/);
  });
});

describe('live location in the browser', () => {
  test('positions are sent every ~10 s, or sooner after moving 25 m', () => {
    const at = { lat: 25.2, lng: 55.27 };
    assert.equal(shouldSend(null, 0, at, 1000), true);
    assert.equal(shouldSend(at, 1000, { lat: 25.20001, lng: 55.27 }, 5000), false); // ~1 m, 4 s
    assert.equal(shouldSend(at, 1000, { lat: 25.2005, lng: 55.27 }, 5000), true); // ~55 m
    assert.equal(shouldSend(at, 1000, at, 11_000), true); // 10 s passed
    assert.equal(Math.round(metresBetween({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) / 1000), 111);
  });
  test('a position held back is sent as soon as allowed: 3 s after a real move, else at 10 s', () => {
    const at = { lat: 25.2, lng: 55.27 };
    assert.equal(sendDelay(at, 1000, { lat: 25.2005, lng: 55.27 }, 2000), 2000); // moved ~55 m, 1 s after: wait 2 s more
    assert.equal(sendDelay(at, 1000, { lat: 25.20001, lng: 55.27 }, 2000), 9000); // barely moved: at the 10 s mark
    assert.equal(sendDelay(at, 1000, { lat: 25.2005, lng: 55.27 }, 9000), 0);
  });
  test('live until the end time, unless stopped', () => {
    const until = new Date(Date.now() + 60_000).toISOString();
    assert.equal(isLiveNow({ active: true, stoppedAt: null, until }), true);
    assert.equal(isLiveNow({ active: true, stoppedAt: new Date().toISOString(), until }), false);
    assert.equal(isLiveNow({ active: true, stoppedAt: null, until }, Date.now() + 61_000), false);
  });
  test('permission problems in words people can act on', () => {
    assert.match(geolocationProblem({ code: 1 }), /blocked\. Allow location for this site/);
    assert.match(geolocationProblem({ code: 2 }), /isn't available/);
    assert.match(geolocationProblem({ code: 3 }), /took too long/);
    assert.match(geolocationProblem(null, false), /secure \(https\)/);
  });
});
