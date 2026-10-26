'use client';

import { useEffect, useState } from 'react';
import type { Message } from '@/lib/inbox';
import {
  TILE_ATTRIBUTION,
  fetchLiveLocation,
  isIncomingLiveLocation,
  liveLinkOf,
  mapLinks,
  parseLocationBody,
  prefersAppleMaps,
  tilesAround,
} from '@/lib/location';
import { isLiveNow, setLive, stopSharing, useLive } from '@/lib/liveSharing';
import { formatTime } from '@/lib/time';

const W = 260;
const H = 140;
const ZOOM = 15;

const pinIcon = (
  <svg className="h-8 w-8 drop-shadow" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7z" fill="#e53935" stroke="#fff" strokeWidth="1.5" />
    <circle cx="12" cy="9" r="2.6" fill="#fff" />
  </svg>
);

// A small map picture centred on the point, made of map tiles (no map library, nothing paid), with the pin
export function MapPreview({ latitude, longitude, live = false }: { latitude: number; longitude: number; live?: boolean }) {
  const tiles = tilesAround(latitude, longitude, ZOOM, W, H);
  return (
    <div className="relative overflow-hidden rounded-lg bg-surface-strong" style={{ width: W, height: H, maxWidth: '100%' }}>
      {tiles.map((t) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={t.url} src={t.url} alt="" draggable={false} loading="lazy" className="absolute max-w-none select-none" style={{ left: t.left, top: t.top, width: 256, height: 256 }} />
      ))}
      <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-full">
        {live ? <span className="block h-5 w-5 translate-y-1/2 rounded-full border-[3px] border-white bg-[#1a73e8] shadow" /> : pinIcon}
      </span>
      <span className="absolute bottom-0 right-0 bg-white/80 px-1 text-[9px] leading-4 text-[#333]">{TILE_ATTRIBUTION}</span>
    </div>
  );
}

function MapsLinks({ latitude, longitude, name }: { latitude: number; longitude: number; name?: string | null }) {
  const links = mapLinks({ latitude, longitude, name });
  return (
    <div className="mt-1.5 flex gap-1.5 text-[11px] font-semibold">
      <a href={links.google} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="flex-1 rounded-md border border-current/20 px-2 py-1 text-center text-link hover:bg-ink/5">
        Google Maps
      </a>
      <a href={links.apple} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="flex-1 rounded-md border border-current/20 px-2 py-1 text-center text-link hover:bg-ink/5">
        Apple Maps
      </a>
    </div>
  );
}

// The map itself opens the point in the map app people have: Apple Maps on Apple devices, Google Maps elsewhere
function MapLink({ latitude, longitude, name, live, label }: { latitude: number; longitude: number; name?: string | null; live?: boolean; label: string }) {
  const [href, setHref] = useState(() => mapLinks({ latitude, longitude, name }).google);
  useEffect(() => {
    const links = mapLinks({ latitude, longitude, name });
    setHref(prefersAppleMaps(navigator.platform, navigator.userAgent) ? links.apple : links.google);
  }, [latitude, longitude, name]);
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title={label} aria-label={label} onClick={(e) => e.stopPropagation()} className="block">
      <MapPreview latitude={latitude} longitude={longitude} live={live} />
    </a>
  );
}

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <div className="w-[260px] max-w-full rounded-lg bg-ink/5 px-3 py-2.5">
      <p className="text-[13px] font-semibold">📍 {title}</p>
      <p className="mt-0.5 text-[12px] opacity-80">{text}</p>
    </div>
  );
}

function PlaceCard({ m }: { m: Message }) {
  if (isIncomingLiveLocation(m))
    return (
      <Notice
        title="Live location"
        text="The customer shared a live location, but WhatsApp doesn't pass live locations on to businesses. Ask them to send their current location instead."
      />
    );
  const place = parseLocationBody(m.body);
  if (!place) return <Notice title="Location" text="The location's details weren't received." />;
  return (
    <div className="w-[260px] max-w-full">
      <MapLink latitude={place.latitude} longitude={place.longitude} name={place.name} label="Open this location in Maps" />
      {(place.name || place.address) && (
        <div className="mt-1.5">
          {place.name && <p className="text-[13px] font-semibold leading-snug">{place.name}</p>}
          {place.address && <p className="text-[12px] leading-snug opacity-75">{place.address}</p>}
        </div>
      )}
      <MapsLinks latitude={place.latitude} longitude={place.longitude} name={place.name} />
    </div>
  );
}

function LiveCard({ m, viewer }: { m: Message; viewer: { userId: string; isAdmin: boolean } | null }) {
  const live = useLive(m.id);
  const [, tick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (live === undefined) fetchLiveLocation(m.id).then((l) => l && setLive(l), () => {});
  }, [live, m.id]);
  // "Live until …" turns into "ended" on time without a server event
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const active = !!live && isLiveNow(live) && m.status !== 'failed';
  const link = liveLinkOf(m.body);
  const canStop = active && !!viewer && (viewer.userId === live!.userId || viewer.isAdmin);
  const pos = live?.position;
  return (
    <div className="w-[260px] max-w-full">
      {pos ? (
        <MapLink latitude={pos.latitude} longitude={pos.longitude} live label="Open the latest shared position in Maps" />
      ) : (
        <div className="flex h-[140px] items-center justify-center rounded-lg bg-ink/5 text-3xl" aria-hidden="true">
          📍
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${active ? 'animate-pulse bg-[#22c55e]' : 'bg-current opacity-40'}`} aria-hidden="true" />
        <p className="text-[13px] font-semibold">{active ? 'Live location' : 'Live location ended'}</p>
      </div>
      <p className="text-[12px] opacity-75">
        {m.status === 'failed'
          ? "Not delivered: the customer didn't get the link."
          : live
            ? active
              ? `${live.sharerName} · until ${formatTime(live.until)}${pos ? ` · updated ${formatTime(pos.at)}` : ''}`
              : `${live.sharerName} · ended ${formatTime(live.stoppedAt ?? live.until)}`
            : live === null
              ? 'Sharing has ended.'
              : 'Loading…'}
      </p>
      {pos && active && <MapsLinks latitude={pos.latitude} longitude={pos.longitude} name="Live location" />}
      <div className="mt-1.5 flex gap-1.5 text-[11px] font-semibold">
        {link && (
          <a href={link} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="flex-1 rounded-md border border-current/20 px-2 py-1 text-center hover:bg-ink/5" title="The page the customer sees">
            Customer's link
          </a>
        )}
        {canStop && (
          <button
            type="button"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              setBusy(true);
              setError('');
              stopSharing(m.id)
                .catch((err) => setError((err as Error).message))
                .finally(() => setBusy(false));
            }}
            className="flex-1 rounded-md bg-danger px-2 py-1 text-center text-white hover:opacity-90 disabled:opacity-60"
          >
            {busy ? 'Stopping…' : 'Stop sharing'}
          </button>
        )}
      </div>
      {error && <p className="mt-1 text-[11px] text-danger">{error}</p>}
    </div>
  );
}

// A location message in a chat bubble (yours or the customer's)
export function LocationCard({ m, viewer }: { m: Message; viewer: { userId: string; isAdmin: boolean } | null }) {
  return m.type === 'live_location' ? <LiveCard m={m} viewer={viewer} /> : <PlaceCard m={m} />;
}
