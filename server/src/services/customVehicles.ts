// The vehicle form's Make / Model / Year lists: the Wheel API's catalog (services/vehicleCatalog.ts) plus makes, models
// and years people added with "+ Add New …", kept in one JSON file (not the database): config/vehicle-catalog.json, or
// VEHICLE_CATALOG_FILE (services/jsonStore.ts: one write at a time, atomic, a damaged file is never overwritten).
// Everything here goes by name ("Toyota", "Land Cruiser"); the Wheel API's slugs are looked up from the names.
//
// File:  { "makes": ["Foton"], "models": { "foton": ["Tunland"] }, "years": { "toyota|land cruiser": [2027] } }
//        (model and year lists are keyed by the lower-case make, and make|model)
import { env } from '../env.js';
import { AppError } from './errors.js';
import { cleanList, jsonStore } from './jsonStore.js';
import { logEvent } from './logging.js';
import { type CatalogOption, vehicleCatalogEnabled, vehicleMakes, vehicleModels, vehicleYears } from './vehicleCatalog.js';

export type VehicleOption = { slug: string | null; name: string; logo: string | null; custom: boolean };
export type VehicleOptionList = { options: VehicleOption[]; error: string | null };
export type VehicleYearList = { years: number[]; error: string | null };

type CustomCatalog = { makes: string[]; models: Record<string, string[]>; years: Record<string, number[]> };

// "  land   cruiser " → "land cruiser": how names are compared (any case, any spacing)
const key = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
const pairKey = (make: string, model: string) => `${key(make)}|${key(model)}`;
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
const maxYear = () => new Date().getFullYear() + 1; // same limit as the vehicle form

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const store = jsonStore<CustomCatalog>({
  file: () => env.vehicleCatalogFile,
  empty: () => ({ makes: [], models: {}, years: {} }),
  parse: (data) => {
    if (!isRecord(data)) throw new Error('expected { "makes": [], "models": {}, "years": {} }');
    const models: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(isRecord(data.models) ? data.models : {})) models[key(k)] = cleanList(v, key);
    const years: Record<string, number[]> = {};
    for (const [k, v] of Object.entries(isRecord(data.years) ? data.years : {}))
      years[k.toLowerCase()] = [...new Set((Array.isArray(v) ? v : []).map(Number).filter((y) => Number.isInteger(y) && y >= 1900 && y <= 2100))];
    return { makes: cleanList(data.makes, key), models, years };
  },
  what: 'vehicle list',
  event: 'vehicle_catalog',
});

// A make or model name as typed: 1–60 characters, letters / numbers and the usual punctuation of vehicle names
function cleanName(raw: unknown, what: 'make' | 'model'): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw new AppError(`Enter a ${what}`, 400, 'BAD_USER_INPUT');
  if (name.length > 60) throw new AppError(`Keep the ${what} to 60 characters or fewer`, 400, 'BAD_USER_INPUT');
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .&'’+/()-]*$/u.test(name)) throw new AppError(`Use letters, numbers, spaces and - . & ' + / ( ) in the ${what}`, 400, 'BAD_USER_INPUT');
  return name;
}

function cleanYear(raw: unknown): number {
  const year = Number(raw);
  if (!Number.isInteger(year) || year < 1900 || year > maxYear()) throw new AppError(`Enter a year from 1900 to ${maxYear()}`, 400, 'BAD_USER_INPUT');
  return year;
}

// A Wheel API call that may be off (no key) or fail: the custom entries are still shown, with the API's error
async function fromApi<T>(load: () => Promise<T>, empty: T): Promise<{ data: T; error: string | null }> {
  if (!vehicleCatalogEnabled()) return { data: empty, error: null };
  try {
    return { data: await load(), error: null };
  } catch (err) {
    return { data: empty, error: (err as Error).message };
  }
}

const apiOption = (o: CatalogOption): VehicleOption => ({ ...o, custom: false });
const customOption = (name: string): VehicleOption => ({ slug: null, name, logo: null, custom: true });

// The Wheel API's slugs for a make (and model) given by name; null when the catalog doesn't have it
async function apiMake(makeName: string) {
  const { data } = await fromApi(vehicleMakes, [] as CatalogOption[]);
  return data.find((m) => key(m.name) === key(makeName)) ?? null;
}
async function apiModel(makeSlug: string, modelName: string) {
  const { data } = await fromApi(() => vehicleModels(makeSlug), [] as CatalogOption[]);
  return data.find((m) => key(m.name) === key(modelName)) ?? null;
}

// Every make (catalog + added), A–Z
export async function listMakes(): Promise<VehicleOptionList> {
  const [api, custom] = await Promise.all([fromApi(vehicleMakes, [] as CatalogOption[]), store.read()]);
  const known = new Set(api.data.map((m) => key(m.name)));
  const options = [...api.data.map(apiOption), ...custom.makes.filter((n) => !known.has(key(n))).map(customOption)].sort(byName);
  return { options, error: api.error };
}

// A make's models (catalog + added), A–Z
export async function listModels(makeRaw: unknown): Promise<VehicleOptionList> {
  const makeName = cleanName(makeRaw, 'make');
  const [make, custom] = await Promise.all([apiMake(makeName), store.read()]);
  const api = make ? await fromApi(() => vehicleModels(make.slug), [] as CatalogOption[]) : { data: [] as CatalogOption[], error: null };
  const known = new Set(api.data.map((m) => key(m.name)));
  const added = (custom.models[key(makeName)] ?? []).filter((n) => !known.has(key(n)));
  return { options: [...api.data.map(apiOption), ...added.map(customOption)].sort(byName), error: api.error };
}

// A model's years, newest first. Empty when the catalog has none for it: the form then offers every year, so added
// years only matter for a model whose catalog list is short of one.
export async function listYears(makeRaw: unknown, modelRaw: unknown): Promise<VehicleYearList> {
  const makeName = cleanName(makeRaw, 'make');
  const modelName = cleanName(modelRaw, 'model');
  const make = await apiMake(makeName);
  const model = make ? await apiModel(make.slug, modelName) : null;
  const api = make && model ? await fromApi(() => vehicleYears(make.slug, model.slug), [] as number[]) : { data: [] as number[], error: null };
  if (!api.data.length) return { years: [], error: api.error };
  const custom = (await store.read()).years[pairKey(makeName, modelName)] ?? [];
  return { years: [...new Set([...api.data, ...custom])].sort((a, b) => b - a), error: api.error };
}

const duplicate = (name: string | number) => new AppError(`${name} is already in the list`, 409, 'DUPLICATE');

export async function addMake(nameRaw: unknown): Promise<VehicleOption> {
  const name = cleanName(nameRaw, 'make');
  const listed = await apiMake(name);
  if (listed) throw duplicate(listed.name);
  await store.update((c) => {
    const existing = c.makes.find((n) => key(n) === key(name));
    if (existing) throw duplicate(existing);
    return { next: { ...c, makes: [...c.makes, name] }, result: null };
  });
  void logEvent({ level: 'SUCCESS', category: 'system', event: 'vehicle_catalog.make_added', message: `Vehicle make ${name} added` });
  return customOption(name);
}

export async function addModel(makeRaw: unknown, nameRaw: unknown): Promise<VehicleOption> {
  const makeName = cleanName(makeRaw, 'make');
  const name = cleanName(nameRaw, 'model');
  const make = await apiMake(makeName);
  const listed = make ? await apiModel(make.slug, name) : null;
  if (listed) throw duplicate(listed.name);
  await store.update((c) => {
    const list = c.models[key(makeName)] ?? [];
    const existing = list.find((n) => key(n) === key(name));
    if (existing) throw duplicate(existing);
    return { next: { ...c, models: { ...c.models, [key(makeName)]: [...list, name] } }, result: null };
  });
  void logEvent({ level: 'SUCCESS', category: 'system', event: 'vehicle_catalog.model_added', message: `Vehicle model ${makeName} ${name} added` });
  return customOption(name);
}

export async function addYear(makeRaw: unknown, modelRaw: unknown, yearRaw: unknown): Promise<number> {
  const makeName = cleanName(makeRaw, 'make');
  const modelName = cleanName(modelRaw, 'model');
  const year = cleanYear(yearRaw);
  const listed = await listYears(makeName, modelName);
  if (listed.years.includes(year)) throw duplicate(year);
  await store.update((c) => {
    const k = pairKey(makeName, modelName);
    const list = c.years[k] ?? [];
    if (list.includes(year)) throw duplicate(year);
    return { next: { ...c, years: { ...c.years, [k]: [...list, year] } }, result: null };
  });
  void logEvent({ level: 'SUCCESS', category: 'system', event: 'vehicle_catalog.year_added', message: `Year ${year} added for ${makeName} ${modelName}` });
  return year;
}
