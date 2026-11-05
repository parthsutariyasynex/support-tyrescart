// Make → Model → Year lists for the vehicle form, from the Wheel API (https://wheel-api.klever.ae/docs.html), through
// this server so the API key stays secret. Keys are domain-scoped: WHEEL_API_DOMAIN is sent as X-Client-Domain (there is
// no browser Origin on a server-to-server call). Answers are cached for a day; the lists hardly ever change.
import { env } from '../env.js';
import { AppError } from './errors.js';

export type CatalogOption = { slug: string; name: string; logo: string | null };

const CACHE_MS = 24 * 60 * 60_000;
const CACHE_MAX = 2000;
const cache = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
// Tests only: replace the network (and empty the cache)
export function setWheelApiFetch(next?: Fetch) {
  fetchImpl = next ?? ((...args) => fetch(...args));
  cache.clear();
  inflight.clear();
}

export const vehicleCatalogEnabled = () => !!env.wheelApiKey;

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  // Many people opening the form at once: one request to the API
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const p = load()
    .then((value) => {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function request(path: string, params: Record<string, string>): Promise<any[]> {
  if (!vehicleCatalogEnabled()) throw new AppError('Vehicle lists are not set up on this server (WHEEL_API_KEY)', 503, 'WHEEL_API_OFF');
  const url = `${env.wheelApiUrl}${path}?${new URLSearchParams({ user_key: env.wheelApiKey, ...params })}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (env.wheelApiDomain) headers['X-Client-Domain'] = env.wheelApiDomain;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new AppError("Couldn't load the vehicle list. Try again.", 502, 'WHEEL_API_UNAVAILABLE');
  }
  const body: any = await res.json().catch(() => null);
  // The API's own reason (docs.html#errors): "Missing user_key", "No active API key for this domain", "Invalid API key"
  const reason = typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : '';
  if (res.status === 401 || res.status === 403)
    throw new AppError(`Vehicle list: ${reason || 'API key refused'}. Check WHEEL_API_KEY and WHEEL_API_DOMAIN on the server.`, 502, 'WHEEL_API_AUTH');
  if (!res.ok) throw new AppError("Couldn't load the vehicle list. Try again.", 502, 'WHEEL_API_UNAVAILABLE');
  return Array.isArray(body?.data) ? body.data : [];
}

const slugOf = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
const cleanSlug = (v: unknown, what: string) => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!s || s.length > 100 || !/^[a-z0-9][a-z0-9._-]*$/.test(s)) throw new AppError(`Choose a valid ${what}`, 400, 'BAD_USER_INPUT');
  return s;
};

const toOption = (r: any): CatalogOption | null => {
  const slug = slugOf(r?.slug);
  const name = slugOf(r?.name_en) || slugOf(r?.name) || slug;
  if (!slug || !name) return null;
  return { slug, name, logo: typeof r?.logo === 'string' && r.logo ? r.logo : null };
};
const byName = (a: CatalogOption, b: CatalogOption) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });

// Every make, A–Z
export function vehicleMakes(): Promise<CatalogOption[]> {
  return cached('makes', async () =>
    (await request('/v1/makes.php', { ordering: 'name', limit: '500' })).map(toOption).filter((o): o is CatalogOption => !!o).sort(byName),
  );
}

// A make's models, A–Z
export function vehicleModels(make: unknown): Promise<CatalogOption[]> {
  const m = cleanSlug(make, 'make');
  return cached(`models|${m}`, async () =>
    (await request('/v1/models.php', { make: m, ordering: 'name', limit: '500' })).map(toOption).filter((o): o is CatalogOption => !!o).sort(byName),
  );
}

// A model's production years, newest first
export function vehicleYears(make: unknown, model: unknown): Promise<number[]> {
  const m = cleanSlug(make, 'make');
  const mo = cleanSlug(model, 'model');
  return cached(`years|${m}|${mo}`, async () => {
    const years = (await request('/v1/years.php', { make: m, model: mo, ordering: '-slug', limit: '1000' }))
      .map((r) => Number(r?.slug ?? r?.name))
      .filter((y) => Number.isInteger(y) && y >= 1900 && y <= 2100);
    return [...new Set(years)].sort((a, b) => b - a);
  });
}
