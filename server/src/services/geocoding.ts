// Address search and "what's here" (reverse geocoding) for the Location screen, through this server so the map
// provider's rules are kept for the whole app: OpenStreetMap's public Nominatim allows at most 1 request a second,
// no search-as-you-type (the app searches when Enter is pressed), results cached, and every request naming the app
// (User-Agent with a contact). GEOCODER_URL switches to another Nominatim server, or "off" turns it off.
import { env } from '../env.js';
import { AppError } from './errors.js';

export type PlaceResult = { latitude: number; longitude: number; name: string | null; address: string };

const MIN_GAP_MS = 1100; // a little over 1 request a second
const MAX_WAIT_MS = 8000; // more queued than this: "try again" rather than a long wait
const CACHE_MS = 24 * 60 * 60_000;
const CACHE_MAX = 1000;

const cache = new Map<string, { at: number; value: unknown }>();
let nextSlot = 0;

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
// Tests only: replace the network (and reset the cache and the request spacing)
export function setGeocoderFetch(next?: Fetch) {
  fetchImpl = next ?? ((...args) => fetch(...args));
  cache.clear();
  nextSlot = 0;
}

export const geocoderEnabled = () => env.geocoderUrl !== 'off' && /^https?:\/\//.test(env.geocoderUrl);

function userAgent() {
  return `${env.appName}/1.0 (support chat location search${env.geocoderContact ? `; ${env.geocoderContact}` : ''})`;
}

// Waits for this request's turn, so requests from everyone together stay under 1 a second
async function turn() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  if (at - now > MAX_WAIT_MS) throw new AppError('Location search is busy. Try again in a few seconds.', 429, 'GEOCODER_BUSY');
  nextSlot = at + MIN_GAP_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const value = await load();
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function request(path: string, params: Record<string, string>, language: string) {
  if (!geocoderEnabled()) throw new AppError('Location search is turned off on this server', 503, 'GEOCODER_OFF');
  await turn();
  const url = `${env.geocoderUrl}${path}?${new URLSearchParams({ format: 'jsonv2', ...params })}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { 'User-Agent': userAgent(), 'Accept-Language': language, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  } catch {
    throw new AppError("Couldn't reach the location search. Try again.", 502, 'GEOCODER_UNAVAILABLE');
  }
  if (res.status === 429) throw new AppError('Location search is busy. Try again in a few seconds.', 429, 'GEOCODER_BUSY');
  if (!res.ok) throw new AppError("Couldn't search locations right now. Try again.", 502, 'GEOCODER_UNAVAILABLE');
  return res.json().catch(() => null);
}

const toPlace = (r: any): PlaceResult | null => {
  const latitude = Number(r?.lat);
  const longitude = Number(r?.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || typeof r?.display_name !== 'string') return null;
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : null;
  return { latitude, longitude, name, address: r.display_name };
};

const cleanLanguage = (language?: string | null) => (language && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(language) ? language : 'en');

// Places and addresses matching what was typed (up to 5), best first
export async function searchPlaces(rawQuery: unknown, language?: string | null): Promise<PlaceResult[]> {
  const query = typeof rawQuery === 'string' ? rawQuery.replace(/\s+/g, ' ').trim() : '';
  if (query.length < 3) throw new AppError('Type at least 3 characters to search', 400, 'BAD_USER_INPUT');
  if (query.length > 200) throw new AppError('That search is too long', 400, 'BAD_USER_INPUT');
  const lang = cleanLanguage(language);
  return cached(`s|${lang}|${query.toLowerCase()}`, async () => {
    const data = await request('/search', { q: query, limit: '5', addressdetails: '0' }, lang);
    return (Array.isArray(data) ? data : []).map(toPlace).filter((p): p is PlaceResult => !!p);
  });
}

// The address at a point (null when there's none, e.g. at sea). Points ~10 m apart share one cached answer.
export async function reversePlace(latitude: number, longitude: number, language?: string | null): Promise<PlaceResult | null> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180)
    throw new AppError('Choose a valid point on the map', 400, 'BAD_USER_INPUT');
  const lang = cleanLanguage(language);
  const lat = latitude.toFixed(4);
  const lon = longitude.toFixed(4);
  const place = await cached(`r|${lang}|${lat},${lon}`, async () => {
    const data: any = await request('/reverse', { lat, lon, zoom: '18' }, lang);
    return !data || data.error ? null : toPlace(data);
  });
  // The point asked about (not where the nearest address is, nor another point that shared the cached answer)
  return place ? { ...place, latitude, longitude } : null;
}
