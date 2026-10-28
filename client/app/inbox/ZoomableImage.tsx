'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BUTTON_FACTOR, FITTED, MAX_ZOOM, MIN_ZOOM, type View, clampView, toggleZoom, wheelFactor, zoomAt } from '@/lib/zoom';

type Point = { x: number; y: number };
type Gesture = { kind: 'pan'; start: Point; from: View } | { kind: 'pinch'; dist: number; mid: Point; from: View };

// A picture in the full-size viewers (chat images, Attachments), fitted and centred, that can be zoomed (1x–5x) and
// moved: mouse wheel / trackpad, pinch on touch screens, drag to move when zoomed in, double-click or double-tap to
// zoom in on that spot and back, the − / % / + bar (the % button goes back to the original size), and the + − 0 keys.
// It never leaves the screen (lib/zoom.ts). A click (or tap) beside the picture calls onBackdropClick (the viewer
// closes); a drag never does.
export function ZoomableImage({ src, alt, onBackdropClick }: { src: string; alt: string; onBackdropClick?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [view, setViewState] = useState<View>(FITTED);
  const viewRef = useRef(view);
  // Animated for buttons, double-click/tap and the wheel; instant while a finger or the mouse moves it
  const [smooth, setSmooth] = useState(true);
  const [dragging, setDragging] = useState(false);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const moved = useRef(false);
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null);
  const lastPointerType = useRef('mouse');
  // Pressed beside the picture (with pointer capture the click itself is reported on the viewer, not the picture)
  const downOnBackdrop = useRef(false);

  const setView = useCallback((v: View, animate: boolean) => {
    viewRef.current = v;
    setSmooth(animate);
    setViewState(v);
  }, []);
  // The picture's fitted size and the viewer's size; a point relative to the viewer's centre
  const dims = useCallback(() => {
    const b = box.current;
    const i = img.current;
    return { size: { w: i?.offsetWidth ?? 0, h: i?.offsetHeight ?? 0 }, screen: { w: b?.clientWidth ?? 0, h: b?.clientHeight ?? 0 } };
  }, []);
  const fromCentre = useCallback((clientX: number, clientY: number): Point => {
    const r = box.current?.getBoundingClientRect();
    return r ? { x: clientX - (r.left + r.width / 2), y: clientY - (r.top + r.height / 2) } : { x: 0, y: 0 };
  }, []);
  const zoomBy = useCallback(
    (factor: number, at: Point = { x: 0, y: 0 }, animate = true) => {
      const { size, screen } = dims();
      setView(zoomAt(viewRef.current, viewRef.current.scale * factor, at, size, screen), animate);
    },
    [dims, setView],
  );
  const reset = useCallback(() => setView(FITTED, true), [setView]);

  // A new picture starts fitted
  useEffect(() => setView(FITTED, false), [src, setView]);

  // Wheel and trackpad (a listener that may prevent the page from scrolling)
  useEffect(() => {
    const b = box.current;
    if (!b) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomBy(wheelFactor(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY), fromCentre(e.clientX, e.clientY));
    };
    b.addEventListener('wheel', onWheel, { passive: false });
    return () => b.removeEventListener('wheel', onWheel);
  }, [zoomBy, fromCentre]);

  // Keys: + / − zoom, 0 back to the original size. A smaller window keeps it on screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '+' || e.key === '=') zoomBy(BUTTON_FACTOR);
      else if (e.key === '-' || e.key === '_') zoomBy(1 / BUTTON_FACTOR);
      else if (e.key === '0') reset();
    };
    const onResize = () => {
      const { size, screen } = dims();
      setView(clampView(viewRef.current, size, screen), false);
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [zoomBy, reset, dims, setView]);

  const startGesture = () => {
    const pts = [...pointers.current.values()];
    if (pts.length >= 2) {
      const [a, b] = pts;
      gesture.current = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: fromCentre((a.x + b.x) / 2, (a.y + b.y) / 2), from: viewRef.current };
    } else if (pts.length === 1) gesture.current = { kind: 'pan', start: pts[0], from: viewRef.current };
    else gesture.current = null;
    setDragging(!!gesture.current && viewRef.current.scale > MIN_ZOOM);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    lastPointerType.current = e.pointerType;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    box.current?.setPointerCapture(e.pointerId);
    if (!pointers.current.size) {
      moved.current = false;
      downOnBackdrop.current = e.target === e.currentTarget;
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    startGesture();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const { size, screen } = dims();
    if (g?.kind === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (g.from.scale * Math.hypot(a.x - b.x, a.y - b.y)) / g.dist));
      const mid = fromCentre((a.x + b.x) / 2, (a.y + b.y) / 2);
      const ratio = scale / g.from.scale;
      // The spot under the fingers stays under them while they spread and move
      setView(clampView({ scale, x: mid.x - (g.mid.x - g.from.x) * ratio, y: mid.y - (g.mid.y - g.from.y) * ratio }, size, screen), false);
      moved.current = true;
    } else if (g?.kind === 'pan') {
      const dx = e.clientX - g.start.x;
      const dy = e.clientY - g.start.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved.current = true;
      if (g.from.scale > MIN_ZOOM) setView(clampView({ scale: g.from.scale, x: g.from.x + dx, y: g.from.y + dy }, size, screen), false);
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    startGesture(); // a pinch that lifts one finger carries on as a drag
    // Double-tap (touch): zoom in on that spot, or back to the original size
    if (e.pointerType !== 'touch' || moved.current || pointers.current.size) return;
    const now = Date.now();
    const prev = lastTap.current;
    if (prev && now - prev.at < 300 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 30) {
      lastTap.current = null;
      const { size, screen } = dims();
      setView(toggleZoom(viewRef.current, fromCentre(e.clientX, e.clientY), size, screen), true);
    } else lastTap.current = { at: now, x: e.clientX, y: e.clientY };
  };

  const zoomed = view.scale > MIN_ZOOM;
  const control = 'flex h-8 min-w-8 items-center justify-center rounded-full px-2 text-sm font-semibold hover:bg-on-primary/20 disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    <div
      ref={box}
      className="relative h-full w-full touch-none select-none overflow-hidden"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => {
        if (lastPointerType.current === 'touch') return; // handled as a double-tap
        const { size, screen } = dims();
        setView(toggleZoom(viewRef.current, fromCentre(e.clientX, e.clientY), size, screen), true);
      }}
      onClick={() => {
        // Beside the picture, without dragging: the viewer closes
        if (!moved.current && downOnBackdrop.current) onBackdropClick?.();
      }}
    >
      <img
        ref={img}
        src={src}
        alt={alt}
        draggable={false}
        onLoad={() => setView(FITTED, false)}
        className="absolute left-1/2 top-1/2 max-h-full max-w-full rounded-lg object-contain"
        style={{
          transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          transition: smooth ? 'transform 180ms ease-out' : 'none',
          cursor: zoomed ? (dragging ? 'grabbing' : 'grab') : 'zoom-in',
          willChange: 'transform',
        }}
      />
      <div
        className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-ink/70 px-1.5 py-1 text-on-primary shadow-lg"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <button type="button" aria-label="Zoom out" title="Zoom out (−)" disabled={!zoomed} onClick={() => zoomBy(1 / BUTTON_FACTOR)} className={control}>
          −
        </button>
        <button type="button" aria-label="Original size" title="Back to original size (0)" disabled={!zoomed} onClick={reset} className={`${control} min-w-14 text-xs tabular-nums`}>
          {Math.round(view.scale * 100)}%
        </button>
        <button type="button" aria-label="Zoom in" title="Zoom in (+)" disabled={view.scale >= MAX_ZOOM} onClick={() => zoomBy(BUTTON_FACTOR)} className={control}>
          +
        </button>
      </div>
    </div>
  );
}
