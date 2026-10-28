// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FITTED, MAX_ZOOM, STEP_ZOOM, clampView, toggleZoom, wheelFactor, zoomAt } from './zoom';

const screen = { w: 1000, h: 800 };
const size = { w: 800, h: 600 }; // the picture fitted on screen

test('fitted, or a side that still fits: stays centred whatever the move', () => {
  assert.deepEqual(clampView({ scale: 1, x: 300, y: -200 }, size, screen), FITTED);
  // At 1.25x the width is 1000 (= screen), the height 750 (< 800): neither can move
  assert.deepEqual(clampView({ scale: 1.25, x: 50, y: 50 }, size, screen), { scale: 1.25, x: 0, y: 0 });
});

test('zoomed in: moves only until an edge reaches the screen edge', () => {
  // At 2x: 1600 x 1200 → up to 300 sideways and 200 up/down
  assert.deepEqual(clampView({ scale: 2, x: 999, y: -999 }, size, screen), { scale: 2, x: 300, y: -200 });
  assert.deepEqual(clampView({ scale: 2, x: -120, y: 80 }, size, screen), { scale: 2, x: -120, y: 80 });
});

test('zoom is kept between 1x and 5x', () => {
  assert.equal(clampView({ scale: 0.2, x: 0, y: 0 }, size, screen).scale, 1);
  assert.equal(zoomAt(FITTED, 40, { x: 0, y: 0 }, size, screen).scale, MAX_ZOOM);
});

test('zooming about a point keeps that spot under the cursor (until an edge would leave the screen)', () => {
  // Cursor 100 px right of centre, zoom 1 → 2: the picture moves 100 px left so that spot stays put
  assert.deepEqual(zoomAt(FITTED, 2, { x: 100, y: 0 }, size, screen), { scale: 2, x: -100, y: 0 });
  // Far corner: limited by the edges
  assert.deepEqual(zoomAt(FITTED, 2, { x: 500, y: 400 }, size, screen), { scale: 2, x: -300, y: -200 });
  // Zooming back out to 1 always re-centres
  assert.deepEqual(zoomAt({ scale: 3, x: -250, y: 120 }, 1, { x: 40, y: -30 }, size, screen), FITTED);
});

test('double-click / double-tap: in on that spot, then back to fitted', () => {
  const zoomed = toggleZoom(FITTED, { x: 0, y: 0 }, size, screen);
  assert.deepEqual(zoomed, { scale: STEP_ZOOM, x: 0, y: 0 });
  assert.deepEqual(toggleZoom(zoomed, { x: 10, y: 10 }, size, screen), FITTED);
});

test('wheel: scrolling up zooms in, down zooms out, nothing is no change', () => {
  assert.ok(wheelFactor(-100) > 1);
  assert.ok(wheelFactor(100) < 1);
  assert.equal(wheelFactor(0), 1);
});
