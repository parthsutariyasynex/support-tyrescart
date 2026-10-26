import { gql } from './api';
import { MESSAGE_FIELDS, type Message } from './inbox';

// Location messages (the server's services/locationFormat.ts writes them): type "location", whose text ends with a
// Google Maps link holding the exact coordinates, after the place's name ("📍 …") and address when known.
// Live locations are type "live_location": a link the customer follows while a teammate shares (15 min to 8 h).

export type Place = { latitude: number; longitude: number; name: string | null; address: string | null };
export type LiveLocation = {
  messageId: string;
  conversationId: string;
  userId: string;
  sharerName: string;
  startedAt: string;
  until: string;
  stoppedAt: string | null;
  active: boolean;
  position: { latitude: number; longitude: number; accuracy: number | null; at: string } | null;
};

const COORDS_LINE = /^https:\/\/maps\.google\.com\/\?q=(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/;
export const validCoords = (lat: number, lng: number) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

export function parseLocationBody(body: string): Place | null {
  const lines = (body ?? '').split('\n');
  const m = COORDS_LINE.exec(lines[lines.length - 1]?.trim() ?? '');
  if (!m) return null;
  const latitude = Number(m[1]);
  const longitude = Number(m[2]);
  if (!validCoords(latitude, longitude)) return null;
  const rest = lines.slice(0, -1);
  const name = rest[0]?.startsWith('📍 ') ? rest.shift()!.slice(3).trim() : '';
  return { latitude, longitude, name: name || null, address: rest.join(' ').trim() || null };
}

// A customer's live location: WhatsApp's API doesn't pass it on to businesses
export const isIncomingLiveLocation = (m: Pick<Message, 'type' | 'body'>) => m.type === 'location' && m.body.trim() === '[live location]';

// The link inside a live location message (what the customer opens)
export const liveLinkOf = (body: string) => /https?:\/\/\S+\/live\/[A-Za-z0-9_-]{24}\b/.exec(body)?.[0] ?? null;

// Chat list / quote line for location messages
export function locationPreview(m: Pick<Message, 'type' | 'body'>): string | null {
  if (m.type === 'live_location') return '📍 Live location';
  if (m.type !== 'location') return null;
  if (isIncomingLiveLocation(m)) return '📍 Live location';
  const place = parseLocationBody(m.body);
  return `📍 ${place?.name || place?.address || 'Location'}`;
}

// Standard map links (no keys, no cost): they open the exact point in the app or website
export function mapLinks(p: { latitude: number; longitude: number; name?: string | null }) {
  const ll = `${p.latitude},${p.longitude}`;
  return {
    google: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ll)}`,
    apple: `https://maps.apple.com/?ll=${encodeURIComponent(ll)}&q=${encodeURIComponent(p.name || 'Shared location')}`,
  };
}

// Apple devices open Apple Maps by default, everything else Google Maps (both are always offered)
export const prefersAppleMaps = (platform: string, userAgent: string) => /Mac|iPhone|iPad|iPod/i.test(platform) || /iPhone|iPad|iPod/i.test(userAgent);

// --- Map tiles (OpenStreetMap by default; NEXT_PUBLIC_MAP_TILE_URL switches provider without code changes) ---

export const TILE_URL = process.env.NEXT_PUBLIC_MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_ATTRIBUTION = process.env.NEXT_PUBLIC_MAP_ATTRIBUTION || '© OpenStreetMap contributors';
// Tile requests must carry a Referer: OpenStreetMap answers ones without it with an "Access blocked" tile, and the
// site's proxy sends Referrer-Policy: same-origin (no Referer to other sites). This sends just our origin per tile.
export const TILE_REFERRER_POLICY = 'strict-origin-when-cross-origin';
const TILE = 256;

// Web Mercator: a point's position in pixels on the whole world map at a zoom level
export function worldPixel(lat: number, lng: number, zoom: number) {
  const size = TILE * 2 ** zoom;
  const r = Math.PI / 180;
  const y = Math.log(Math.tan(lat * r) + 1 / Math.cos(lat * r));
  return { x: ((lng + 180) / 360) * size, y: ((1 - y / Math.PI) / 2) * size };
}

// The tiles that cover a width × height picture centred on a point, and where each goes
export function tilesAround(lat: number, lng: number, zoom: number, width: number, height: number) {
  const c = worldPixel(lat, lng, zoom);
  const left = c.x - width / 2;
  const top = c.y - height / 2;
  const n = 2 ** zoom;
  const out: { url: string; left: number; top: number }[] = [];
  for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + width - 1) / TILE); tx++)
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + height - 1) / TILE); ty++) {
      if (ty < 0 || ty >= n) continue;
      const x = ((tx % n) + n) % n;
      out.push({ url: TILE_URL.replace('{z}', String(zoom)).replace('{x}', String(x)).replace('{y}', String(ty)), left: Math.round(tx * TILE - left), top: Math.round(ty * TILE - top) });
    }
  return out;
}

// --- API ---

const LIVE = 'messageId conversationId userId sharerName startedAt until stoppedAt active position { latitude longitude accuracy at }';

export async function sendLocation(conversationId: string, place: Place, replyToId?: string | null) {
  const query = `mutation SendLocation($input: SendLocationInput!) { sendLocationMessage(input: $input) { ${MESSAGE_FIELDS} } }`;
  const input = { conversationId, latitude: place.latitude, longitude: place.longitude, name: place.name, address: place.address, ...(replyToId ? { replyToId } : {}) };
  return (await gql<{ sendLocationMessage: Message }>(query, { input })).sendLocationMessage;
}

export async function locationSearchEnabled() {
  return (await gql<{ locationSearchEnabled: boolean }>('query { locationSearchEnabled }')).locationSearchEnabled;
}

const browserLanguage = () => (typeof navigator !== 'undefined' ? navigator.language : 'en');

export async function searchPlaces(query: string) {
  const q = 'query SearchPlaces($query: String!, $language: String) { searchPlaces(query: $query, language: $language) { latitude longitude name address } }';
  return (await gql<{ searchPlaces: Place[] }>(q, { query, language: browserLanguage() })).searchPlaces;
}

export async function reversePlace(latitude: number, longitude: number) {
  const q = 'query ReversePlace($latitude: Float!, $longitude: Float!, $language: String) { reversePlace(latitude: $latitude, longitude: $longitude, language: $language) { latitude longitude name address } }';
  return (await gql<{ reversePlace: Place | null }>(q, { latitude, longitude, language: browserLanguage() })).reversePlace;
}

export async function startLiveLocation(conversationId: string, minutes: number, pos: { latitude: number; longitude: number; accuracy: number | null }) {
  const q = `mutation StartLive($input: StartLiveLocationInput!) { startLiveLocation(input: $input) { message { ${MESSAGE_FIELDS} } live { ${LIVE} } } }`;
  return (await gql<{ startLiveLocation: { message: Message; live: LiveLocation } }>(q, { input: { conversationId, minutes, ...pos } })).startLiveLocation;
}

export async function updateLiveLocation(messageId: string, pos: { latitude: number; longitude: number; accuracy: number | null }) {
  const q = `mutation UpdateLive($messageId: ID!, $position: LivePositionInput!) { updateLiveLocation(messageId: $messageId, position: $position) { ${LIVE} } }`;
  return (await gql<{ updateLiveLocation: LiveLocation }>(q, { messageId, position: pos })).updateLiveLocation;
}

export async function stopLiveLocation(messageId: string) {
  const q = `mutation StopLive($messageId: ID!) { stopLiveLocation(messageId: $messageId) { ${LIVE} } }`;
  return (await gql<{ stopLiveLocation: LiveLocation }>(q, { messageId })).stopLiveLocation;
}

export async function fetchLiveLocation(messageId: string) {
  const q = `query Live($messageId: ID!) { liveLocation(messageId: $messageId) { ${LIVE} } }`;
  return (await gql<{ liveLocation: LiveLocation | null }>(q, { messageId })).liveLocation;
}

export async function fetchMyLiveLocations() {
  return (await gql<{ myLiveLocations: LiveLocation[] }>(`query { myLiveLocations { ${LIVE} } }`)).myLiveLocations;
}

export const LIVE_OPTIONS = [
  { minutes: 15, label: '15 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 480, label: '8 hours' },
] as const;

// Why the browser gave no position, in words people can act on
export function geolocationProblem(err: { code?: number } | null | undefined, secure = true) {
  if (!secure) return 'Location needs a secure (https) connection to this app.';
  switch (err?.code) {
    case 1:
      return 'Location access is blocked. Allow location for this site in your browser settings (the icon next to the address bar), then try again.';
    case 2:
      return "Your location isn't available right now (no GPS or network position). Try again, or pick the place on the map.";
    case 3:
      return 'Finding your location took too long. Try again, or pick the place on the map.';
    default:
      return "This browser can't share your location. Pick the place on the map instead.";
  }
}
