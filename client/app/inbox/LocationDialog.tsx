'use client';

import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Map as LeafletMap, Marker, CircleMarker, Circle } from 'leaflet';
import type { Message } from '@/lib/inbox';
import {
  LIVE_OPTIONS,
  type LiveLocation,
  type Place,
  TILE_ATTRIBUTION,
  TILE_URL,
  geolocationProblem,
  locationSearchEnabled,
  reversePlace,
  searchPlaces,
  sendLocation,
  startLiveLocation,
} from '@/lib/location';

type Fix = { latitude: number; longitude: number; accuracy: number | null };

const PIN_SVG =
  '<svg width="34" height="44" viewBox="0 0 24 31" xmlns="http://www.w3.org/2000/svg"><path d="M12 1a10 10 0 0 0-10 10c0 7.5 10 19 10 19s10-11.5 10-19A10 10 0 0 0 12 1z" fill="#e53935" stroke="#fff" stroke-width="1.6"/><circle cx="12" cy="11" r="3.6" fill="#fff"/></svg>';

const rowClass = 'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50';
const iconClass = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white';

// Location (from the 📎 menu), like WhatsApp's: the map opens on where you are (when the browser may tell), with a
// pin you drag or move by tapping the map; search for a place or address; send your current location or the
// pinned one; or share your live location for 15 minutes, 1 hour or 8 hours.
export function LocationDialog({
  conversationId,
  replyToId,
  onSent,
  onLiveStarted,
  onClose,
}: {
  conversationId: string;
  replyToId?: string | null;
  onSent: (m: Message) => void;
  onLiveStarted: (m: Message, live: LiveLocation) => void;
  onClose: () => void;
}) {
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const pinRef = useRef<Marker | null>(null);
  const meRef = useRef<{ dot: CircleMarker; ring: Circle } | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);
  const [locating, setLocating] = useState(true);
  const [gpsProblem, setGpsProblem] = useState('');
  const [pin, setPin] = useState<{ latitude: number; longitude: number } | null>(null);
  const [pinPlace, setPinPlace] = useState<Place | null>(null); // name/address of the pinned point
  const [resolving, setResolving] = useState(false);
  const [searchOn, setSearchOn] = useState(true);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [liveOpen, setLiveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  useEffect(() => {
    locationSearchEnabled().then(setSearchOn, () => setSearchOn(false));
  }, []);

  // The map (Leaflet is loaded only when this opens; it needs the browser)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import('leaflet')).default;
      if (cancelled || !mapEl.current || map.current) return;
      const m = L.map(mapEl.current, { zoomControl: true, attributionControl: true, worldCopyJump: true }).setView([20, 0], 2);
      m.attributionControl.setPrefix(false);
      L.tileLayer(TILE_URL, { maxZoom: 19, attribution: `<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">${TILE_ATTRIBUTION}</a>` }).addTo(m);
      const marker = L.marker([20, 0], {
        draggable: true,
        autoPan: true,
        keyboard: true,
        title: 'Drag to choose the location',
        icon: L.divIcon({ html: PIN_SVG, className: '', iconSize: [34, 44], iconAnchor: [17, 43] }),
      });
      marker.on('dragend', () => {
        const p = marker.getLatLng();
        choose({ latitude: p.lat, longitude: p.lng });
      });
      m.on('click', (e) => {
        marker.setLatLng(e.latlng);
        if (!m.hasLayer(marker)) marker.addTo(m);
        choose({ latitude: e.latlng.lat, longitude: e.latlng.lng });
      });
      map.current = m;
      pinRef.current = marker;
      // The dialog has just laid out: let the map measure itself
      requestAnimationFrame(() => m.invalidateSize());
      locate(L);
    })();
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Asks the browser where you are (it asks you first, the first time). Denied or unavailable: the map still works.
  function locate(L?: typeof import('leaflet')) {
    setLocating(true);
    setGpsProblem('');
    if (!window.isSecureContext || !navigator.geolocation) {
      setLocating(false);
      setGpsProblem(geolocationProblem(null, window.isSecureContext));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const f = { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null };
        setFix(f);
        setLocating(false);
        const Lf = L ?? (await import('leaflet')).default;
        const m = map.current;
        if (!m) return;
        if (meRef.current) {
          meRef.current.dot.setLatLng([f.latitude, f.longitude]);
          meRef.current.ring.setLatLng([f.latitude, f.longitude]).setRadius(f.accuracy ?? 0);
        } else {
          const ring = Lf.circle([f.latitude, f.longitude], { radius: f.accuracy ?? 0, color: '#1a73e8', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(m);
          const dot = Lf.circleMarker([f.latitude, f.longitude], { radius: 7, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1, interactive: false }).addTo(m);
          meRef.current = { dot, ring };
        }
        m.setView([f.latitude, f.longitude], 16);
        // The pin starts where you are, ready to be moved
        if (!pinRef.current?.getElement()) {
          pinRef.current?.setLatLng([f.latitude, f.longitude]).addTo(m);
          choose({ latitude: f.latitude, longitude: f.longitude });
        }
      },
      (err) => {
        setLocating(false);
        setGpsProblem(geolocationProblem(err));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  }

  // The pinned point and, shortly after it settles, its address (looked up once it stops moving)
  const reverseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function choose(p: { latitude: number; longitude: number }, known?: Place) {
    setPin(p);
    setError('');
    if (reverseTimer.current) clearTimeout(reverseTimer.current);
    if (known) {
      setPinPlace(known);
      setResolving(false);
      return;
    }
    setPinPlace(null);
    setResolving(true);
    reverseTimer.current = setTimeout(() => {
      reversePlace(p.latitude, p.longitude)
        .then((place) => setPinPlace(place))
        .catch(() => setPinPlace(null))
        .finally(() => setResolving(false));
    }, 700);
  }
  useEffect(() => () => void (reverseTimer.current && clearTimeout(reverseTimer.current)), []);

  async function search() {
    const q = query.trim();
    if (q.length < 3) return setError('Type at least 3 characters to search.');
    setSearching(true);
    setError('');
    try {
      setResults(await searchPlaces(q));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSearching(false);
    }
  }

  function pick(place: Place) {
    setResults(null);
    const m = map.current;
    if (m && pinRef.current) {
      pinRef.current.setLatLng([place.latitude, place.longitude]);
      if (!m.hasLayer(pinRef.current)) pinRef.current.addTo(m);
      m.setView([place.latitude, place.longitude], 17);
    }
    choose({ latitude: place.latitude, longitude: place.longitude }, place);
  }

  async function send(place: Place) {
    setBusy(true);
    setError('');
    try {
      onSent(await sendLocation(conversationId, place, replyToId));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function sendCurrent() {
    if (!fix) return;
    setBusy(true);
    setError('');
    // The address of where you are (best effort: without it the pin is still exact)
    const here = await reversePlace(fix.latitude, fix.longitude).catch(() => null);
    await send({ latitude: fix.latitude, longitude: fix.longitude, name: null, address: here?.address ?? null });
  }

  async function shareLive(minutes: number) {
    if (!fix) return setError(gpsProblem || 'Your location is needed to share it live. Allow location for this site and try again.');
    setBusy(true);
    setError('');
    try {
      const r = await startLiveLocation(conversationId, minutes, fix);
      onLiveStarted(r.message, r.live);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const pinLabel = pinPlace?.name || pinPlace?.address?.split(',').slice(0, 2).join(',') || (resolving ? 'Finding the address…' : pin ? `${pin.latitude.toFixed(5)}, ${pin.longitude.toFixed(5)}` : '');

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/50 p-4" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Send location" className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-line-soft px-5 py-3">
          <h2 className="text-sm font-bold text-ink">Send location</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="rounded-lg p-1 text-muted hover:bg-surface-muted disabled:opacity-50">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Search: runs when asked (Enter), never while typing (the free map search allows no search-as-you-type) */}
        {searchOn && (
          <form
            className="flex gap-2 border-b border-line-soft px-4 py-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              search();
            }}
          >
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search for a place or address"
              aria-label="Search for a place or address"
              className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-ink outline-hidden placeholder:text-faint focus:border-primary focus:ring-1 focus:ring-primary"
            />
            <button type="submit" disabled={searching || busy} className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-60">
              {searching ? 'Searching…' : 'Search'}
            </button>
          </form>
        )}

        <div className="relative">
          <div ref={mapEl} className="h-[300px] w-full bg-surface-muted" aria-label="Map: tap or drag the pin to choose a place" />
          {fix && (
            <button
              type="button"
              onClick={() => {
                map.current?.setView([fix.latitude, fix.longitude], 16);
                pinRef.current?.setLatLng([fix.latitude, fix.longitude]);
                choose({ latitude: fix.latitude, longitude: fix.longitude });
              }}
              title="Back to where you are"
              aria-label="Back to where you are"
              className="absolute bottom-6 left-2.5 z-[500] flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface text-primary shadow"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
              </svg>
            </button>
          )}
          {results && (
            <ul className="absolute inset-x-0 top-0 z-[600] max-h-[300px] overflow-y-auto bg-surface shadow-lg" aria-label="Search results">
              {results.length === 0 && <li className="px-4 py-3 text-xs text-muted">Nothing found. Try another name or address, or pick the place on the map.</li>}
              {results.map((r, i) => (
                <li key={`${r.latitude},${r.longitude},${i}`}>
                  <button type="button" onClick={() => pick(r)} className="block w-full border-b border-line-soft px-4 py-2.5 text-left hover:bg-surface-muted">
                    <span className="block text-[13px] font-semibold text-ink">{r.name || (r.address ?? '').split(',')[0]}</span>
                    <span className="block truncate text-[11px] text-muted">{r.address}</span>
                  </button>
                </li>
              ))}
              <li>
                <button type="button" onClick={() => setResults(null)} className="w-full px-4 py-2 text-center text-xs font-semibold text-primary hover:bg-surface-muted">
                  Back to the map
                </button>
              </li>
            </ul>
          )}
        </div>

        <div className="overflow-y-auto p-2">
          {gpsProblem && <p className="mx-2 mb-1 rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning" role="status">{gpsProblem}</p>}

          <button type="button" className={rowClass} disabled={!fix || busy} onClick={sendCurrent}>
            <span className={`${iconClass} bg-[#1a73e8]`} aria-hidden="true">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold text-ink">Send your current location</span>
              <span className="block text-[11px] text-muted">
                {locating ? 'Finding your location…' : fix ? `Accurate to ${fix.accuracy ?? '?'} m` : 'Not available'}
              </span>
            </span>
          </button>
          {!locating && !fix && (
            <button type="button" onClick={() => locate()} className="ml-14 rounded-md px-2 py-1 text-[11px] font-semibold text-primary hover:bg-primary-subtle">
              Try finding my location again
            </button>
          )}

          <button type="button" className={rowClass} disabled={!pin || busy} onClick={() => pin && send({ latitude: pin.latitude, longitude: pin.longitude, name: pinPlace?.name ?? null, address: pinPlace?.address ?? null })}>
            <span className={`${iconClass} bg-[#e53935]`} aria-hidden="true">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z" /></svg>
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold text-ink">Send this location</span>
              <span className="block truncate text-[11px] text-muted">{pin ? pinLabel : 'Tap the map or search to choose a place'}</span>
            </span>
          </button>

          <button type="button" className={rowClass} disabled={busy} onClick={() => setLiveOpen((o) => !o)} aria-expanded={liveOpen}>
            <span className={`${iconClass} bg-[#22a06b]`} aria-hidden="true">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="12" cy="12" r="2.5" fill="currentColor" /><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14" /></svg>
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold text-ink">Share live location</span>
              <span className="block text-[11px] text-muted">The customer gets a link that follows you on a map</span>
            </span>
          </button>
          {liveOpen && (
            <div className="mx-3 mb-2 rounded-xl border border-line bg-surface-muted p-3">
              <div className="flex gap-2">
                {LIVE_OPTIONS.map((o) => (
                  <button
                    key={o.minutes}
                    type="button"
                    disabled={busy || !fix}
                    onClick={() => shareLive(o.minutes)}
                    className="flex-1 rounded-lg border border-line bg-surface px-2 py-2 text-xs font-semibold text-ink hover:border-primary hover:text-primary disabled:opacity-50"
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-snug text-muted">
                WhatsApp doesn't let businesses send a live location, so the customer gets a message with a private link to a
                map that follows you. Keep this app open while sharing; you can stop at any time.
                {!fix && ' Your location is needed first.'}
              </p>
            </div>
          )}

          {error && <p className="mx-2 mt-1 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
          {busy && <p className="px-3 py-1 text-xs text-muted">Sending…</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
