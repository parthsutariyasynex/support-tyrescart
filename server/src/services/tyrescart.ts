import { env } from '../env.js';

// Tyrescart's catalogue for the AI Robot (services/aiRobot.ts), read from the Tyrescart site's GraphQL API (Magento,
// HTTP Basic auth; TYRESCART_GRAPHQL_URL / _USER / _PASSWORD). The only source the robot may take prices, stock, sizes
// and product names from.
//
//   searchTyres     Magento's standard products query, by size (search text "245/40 R18" + width/height filters; the
//                   API has no rim filter and no price sort, so both are done here). In stock first, cheapest first.
//                   Prices are per tyre and fully fitted (VAT and fitting included, confirmed by the lead); the prices
//                   for 2 and 4 tyres are calculated here, so the AI never does the maths.
//   findTyreSize    The site's vehicle fitment queries (kleverVehicleMakes → Models → Years → Modifications): the front
//                   and rear sizes for a car.
//
// Product links: <TYRESCART_SITE_URL>/en/<url_key> (the site's own format, checked on QA). Answers are cached for
// 5 minutes per query; each request times out after 10 seconds. Errors are thrown: the robot hands the chat over.

const CACHE_MS = 5 * 60 * 1000;
const CACHE_MAX = 500;
const TIMEOUT_MS = 10_000;
// Products read per search before filtering by rim and sorting (the search text also matches other sizes)
const PAGE_SIZE = 100;
export const MAX_RESULTS = 5;

export class CatalogueError extends Error {}

export const catalogueConfigured = () => !!fake || !!env.tyrescartGraphqlUrl;

type Fetcher = (query: string) => Promise<unknown>;
let fake: Fetcher | null = null;
// Tests: answer GraphQL queries with this instead of calling the site (null: back to normal). The cache is cleared.
export function setTyrescartForTests(fetcher: Fetcher | null) {
  fake = fetcher;
  cache.clear();
}

const cache = new Map<string, { at: number; data: unknown }>();

async function query<T>(text: string): Promise<T> {
  const hit = cache.get(text);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data as T;
  let data: unknown;
  if (fake) data = await fake(text);
  else {
    if (!env.tyrescartGraphqlUrl) throw new CatalogueError('The Tyrescart catalogue is not set up on this server (TYRESCART_GRAPHQL_URL)');
    const auth: Record<string, string> = env.tyrescartGraphqlUser ? { Authorization: `Basic ${Buffer.from(`${env.tyrescartGraphqlUser}:${env.tyrescartGraphqlPassword}`).toString('base64')}` } : {};
    let res: Response;
    try {
      res = await fetch(env.tyrescartGraphqlUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify({ query: text }), signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new CatalogueError(`The Tyrescart catalogue could not be reached: ${(err as Error).message}`);
    }
    const body = (await res.json().catch(() => null)) as { data?: unknown; errors?: { message?: string }[] } | null;
    if (!res.ok || !body) throw new CatalogueError(`The Tyrescart catalogue answered HTTP ${res.status}`);
    if (body.errors?.length) throw new CatalogueError(`The Tyrescart catalogue answered with an error: ${body.errors.map((e) => e.message).join('; ').slice(0, 300)}`);
    data = body.data;
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(text, { at: Date.now(), data });
  return data as T;
}

// A GraphQL string literal (JSON's escaping is valid GraphQL)
const str = (s: string) => JSON.stringify(s);
const intOf = (v: unknown) => {
  const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// --- Product search

export type TyreSearch = { width: unknown; height: unknown; rim: unknown; brand?: unknown; pattern?: unknown; category?: unknown; max_price_per_tyre?: unknown };
export type TyreOption = {
  id: string;
  name: string;
  in_stock: boolean;
  price_per_tyre: string;
  price_for_2: string;
  price_for_4: string;
  percent_off: number | null;
  regular_price_per_tyre: string | null;
  link: string | null;
};
export type TyreResult = { size: string; total_found: number; options: TyreOption[]; prices: number[]; note?: string };

type ProductRow = {
  sku: string;
  name: string;
  url_key: string | null;
  stock_status: string | null;
  price_range: { minimum_price: { regular_price: { value: number | null }; final_price: { value: number | null; currency: string | null }; discount: { percent_off: number | null } | null } };
};

// "AED 1,019" (whole dirhams without decimals, otherwise 2 decimals)
export const aed = (n: number) => `AED ${n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
const money = (n: number) => Math.round(n * 100) / 100;
const CATEGORIES = new Map(['budget', 'quality', 'premium'].map((c) => [c, c[0].toUpperCase() + c.slice(1)]));

export async function searchTyres(args: TyreSearch): Promise<TyreResult> {
  const width = intOf(args.width);
  const height = intOf(args.height);
  const rim = intOf(args.rim);
  if (!width || !height || !rim) throw new CatalogueError('search_tyres needs width, height and rim (e.g. 245, 40, 18)');
  const size = `${width}/${height} R${rim}`;
  const brand = typeof args.brand === 'string' && args.brand.trim() ? args.brand.trim().slice(0, 40) : null;
  const pattern = typeof args.pattern === 'string' && args.pattern.trim() ? args.pattern.trim().slice(0, 40) : null;
  const category = typeof args.category === 'string' ? CATEGORIES.get(args.category.trim().toLowerCase()) ?? null : null;
  const maxPrice = intOf(args.max_price_per_tyre);

  const filter = [`width: { eq: ${str(String(width))} }`, `height: { eq: ${str(String(height))} }`, brand ? `brand: { eq: ${str(brand)} }` : '', category ? `tyres_category: { eq: ${str(category)} }` : ''].filter(Boolean).join(', ');
  const data = await query<{ products: { total_count: number; items: ProductRow[] } | null }>(
    `{ products(search: ${str(size)}, filter: { ${filter} }, pageSize: ${PAGE_SIZE}) { total_count items { sku name url_key stock_status price_range { minimum_price { regular_price { value } final_price { value currency } discount { percent_off } } } } } }`,
  );
  // The search text also matches other rims and sizes: keep the exact size (the name holds "245/40 R18")
  const sizeIn = new RegExp(`(^|[^0-9])${width}/${height}\\s*Z?R\\s?${rim}(?![0-9])`, 'i');
  const rows = (data?.products?.items ?? []).filter((p) => p?.name && sizeIn.test(p.name) && typeof p.price_range?.minimum_price?.final_price?.value === 'number' && p.price_range.minimum_price.final_price.value > 0);
  const matching = rows.filter(
    (p) =>
      (!brand || norm(p.name).startsWith(norm(brand)) || norm(p.name).includes(norm(brand))) &&
      (!pattern || norm(p.name).includes(norm(pattern))) &&
      (!maxPrice || p.price_range.minimum_price.final_price.value! <= maxPrice),
  );
  const price = (p: ProductRow) => p.price_range.minimum_price.final_price.value!;
  const inStock = (p: ProductRow) => p.stock_status === 'IN_STOCK';
  matching.sort((a, b) => Number(inStock(b)) - Number(inStock(a)) || price(a) - price(b));
  const picked = matching.slice(0, MAX_RESULTS);

  const prices: number[] = [];
  const options = picked.map((p): TyreOption => {
    const each = money(price(p));
    const regular = p.price_range.minimum_price.regular_price?.value ?? null;
    const off = p.price_range.minimum_price.discount?.percent_off ?? 0;
    prices.push(each, money(each * 2), money(each * 4));
    if (off > 0 && regular) prices.push(money(regular));
    return {
      id: p.sku,
      name: p.name,
      in_stock: inStock(p),
      price_per_tyre: aed(each),
      price_for_2: aed(money(each * 2)),
      price_for_4: aed(money(each * 4)),
      percent_off: off > 0 ? Math.round(off) : null,
      regular_price_per_tyre: off > 0 && regular ? aed(money(regular)) : null,
      link: env.tyrescartSiteUrl && p.url_key ? `${env.tyrescartSiteUrl}/en/${p.url_key}` : null,
    };
  });
  const note = !options.length
    ? `No ${size} tyres found${brand ? ` from ${brand}` : ''}${pattern ? ` (${pattern})` : ''}${category ? ` in ${category}` : ''}${maxPrice ? ` up to AED ${maxPrice} per tyre` : ''}.`
    : options.every((o) => !o.in_stock)
      ? 'All of these are out of stock.'
      : undefined;
  return { size, total_found: matching.length, options, prices, ...(note ? { note } : {}) };
}

// --- Which size fits a car

type Named = { name: string; slug: string };
export type FitmentResult =
  | { status: 'found'; vehicle: string; sizes: { trim: string; front: string; rear: string; same_front_and_rear: boolean; factory: boolean }[] }
  | { status: 'need_year'; vehicle: string; years: string[] }
  | { status: 'need_model'; make: string; models: string[] }
  | { status: 'not_found'; message: string };

function pick(list: Named[], wanted: string): Named[] {
  const w = norm(wanted);
  if (!w) return [];
  const exact = list.filter((x) => norm(x.name) === w || norm(x.slug) === w);
  if (exact.length) return exact;
  return list.filter((x) => norm(x.name).startsWith(w) || w.startsWith(norm(x.name)) || norm(x.name).includes(w));
}
const listOf = <T>(v: T[] | T | null | undefined): T[] => (Array.isArray(v) ? v : v ? [v] : []);

export async function findTyreSize(args: { make?: unknown; model?: unknown; year?: unknown }): Promise<FitmentResult> {
  const make = typeof args.make === 'string' ? args.make.trim() : '';
  const model = typeof args.model === 'string' ? args.model.trim() : '';
  if (!make || !model) return { status: 'not_found', message: 'find_tyre_size needs the make and the model' };

  const makes = listOf((await query<{ kleverVehicleMakes: { data: Named[] } | null }>('{ kleverVehicleMakes { data { name slug } } }'))?.kleverVehicleMakes?.data);
  const [m] = pick(makes, make);
  if (!m) return { status: 'not_found', message: `The make "${make}" is not in the Tyrescart fitment guide` };

  const models = listOf((await query<{ kleverVehicleModels: { data: Named[] } | null }>(`{ kleverVehicleModels(make: ${str(m.slug)}) { data { name slug } } }`))?.kleverVehicleModels?.data);
  const found = pick(models, model);
  if (!found.length) return { status: 'not_found', message: `The model "${model}" was not found for ${m.name}` };
  if (found.length > 1 && !found.some((x) => norm(x.name) === norm(model))) return { status: 'need_model', make: m.name, models: found.slice(0, 10).map((x) => x.name) };
  const mo = found.find((x) => norm(x.name) === norm(model)) ?? found[0];
  const vehicle = `${m.name} ${mo.name}`;

  const years = listOf((await query<{ kleverVehicleYears: { data: Named[] } | null }>(`{ kleverVehicleYears(make: ${str(m.slug)}, model: ${str(mo.slug)}) { data { name slug } } }`))?.kleverVehicleYears?.data);
  let year = intOf(args.year);
  if (year && years.length && !years.some((y) => intOf(y.slug ?? y.name) === year)) return { status: 'not_found', message: `${vehicle} ${year} is not in the Tyrescart fitment guide (years: ${years.map((y) => y.name).slice(-12).join(', ')})` };
  if (!year) {
    if (years.length !== 1) return { status: 'need_year', vehicle, years: years.map((y) => y.name).slice(-15) };
    year = intOf(years[0].slug ?? years[0].name);
  }
  if (!year) return { status: 'not_found', message: `No years found for ${vehicle}` };

  type Mod = { name: string | null; trim: string | null; is_stock: unknown; front_wheel: { tire_full: string | null } | { tire_full: string | null }[] | null; rear_wheel: { tire_full: string | null } | { tire_full: string | null }[] | null };
  const mods = listOf((await query<{ kleverVehicleModifications: { data: Mod[] } | null }>(`{ kleverVehicleModifications(make: ${str(m.slug)}, model: ${str(mo.slug)}, year: ${year}) { data { name trim is_stock front_wheel { tire_full } rear_wheel { tire_full } } } }`))?.kleverVehicleModifications?.data);
  const seen = new Set<string>();
  const sizes: Extract<FitmentResult, { status: 'found' }>['sizes'] = [];
  for (const mod of mods) {
    const fronts = listOf(mod.front_wheel).map((w) => w?.tire_full).filter((s): s is string => !!s);
    const rears = listOf(mod.rear_wheel).map((w) => w?.tire_full).filter((s): s is string => !!s);
    fronts.forEach((front, i) => {
      const rear = rears[i] ?? front;
      const key = `${front}|${rear}`;
      if (seen.has(key)) return;
      seen.add(key);
      sizes.push({ trim: [mod.name, mod.trim].filter(Boolean).join(' ') || 'all', front, rear, same_front_and_rear: front === rear, factory: mod.is_stock === true || mod.is_stock === 1 || mod.is_stock === '1' });
    });
  }
  if (!sizes.length) return { status: 'not_found', message: `No tyre sizes found for ${vehicle} ${year}` };
  return { status: 'found', vehicle: `${vehicle} ${year}`, sizes: sizes.slice(0, 10) };
}
