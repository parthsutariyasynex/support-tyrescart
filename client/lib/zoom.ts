// Zooming a picture in the full-size image viewer (app/inbox/ZoomableImage.tsx): the maths only, no DOM.
// The picture is shown fitted and centred (scale 1), then scaled about its centre and moved by (x, y) pixels.
// x/y are kept so the picture never leaves the screen: a side bigger than the screen can be moved only until its
// edge reaches the screen's edge; a side that fits stays centred.

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 5;
// Double-click / double-tap / the + and − buttons
export const STEP_ZOOM = 2.5;
export const BUTTON_FACTOR = 1.5;

export type View = { scale: number; x: number; y: number };
export type Size = { w: number; h: number };
export const FITTED: View = { scale: 1, x: 0, y: 0 };

const clampNumber = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

// size: the picture's fitted size (scale 1); screen: the viewer's size
export function clampView(v: View, size: Size, screen: Size): View {
  const scale = clampNumber(v.scale, MIN_ZOOM, MAX_ZOOM);
  const maxX = Math.max(0, (size.w * scale - screen.w) / 2);
  const maxY = Math.max(0, (size.h * scale - screen.h) / 2);
  // + 0: never -0 (centred is exactly 0)
  return { scale, x: clampNumber(v.x, -maxX, maxX) + 0, y: clampNumber(v.y, -maxY, maxY) + 0 };
}

// Zoom to `scale` keeping the spot under `point` (relative to the screen's centre) where it is: the cursor for the
// wheel and double-click, the fingers' midpoint for a pinch, the centre for the buttons
export function zoomAt(v: View, scale: number, point: { x: number; y: number }, size: Size, screen: Size): View {
  const next = clampNumber(scale, MIN_ZOOM, MAX_ZOOM);
  const ratio = next / v.scale;
  return clampView({ scale: next, x: point.x - (point.x - v.x) * ratio, y: point.y - (point.y - v.y) * ratio }, size, screen);
}

// The mouse wheel / trackpad: a smooth factor per scroll amount (up zooms in)
export const wheelFactor = (deltaY: number) => Math.exp(-deltaY * 0.0025);

// Double-click / double-tap: zoomed in → back to fitted; fitted → zoom in on that spot
export function toggleZoom(v: View, point: { x: number; y: number }, size: Size, screen: Size): View {
  return v.scale > MIN_ZOOM ? FITTED : zoomAt(v, STEP_ZOOM, point, size, screen);
}
