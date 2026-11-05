// The tyre sizes offered by the vehicle form's Tyre Size dropdowns, kept in one JSON file (not the database):
// config/tyre-sizes.json, or TYRE_SIZES_FILE. Sizes added from the app are written back to it (services/jsonStore.ts:
// one write at a time, atomic, a damaged file is never overwritten).
import { env } from '../env.js';
import { AppError } from './errors.js';
import { cleanList, jsonStore } from './jsonStore.js';
import { logEvent } from './logging.js';

const MAX_LENGTH = 30; // same limit as the vehicle's tyre size fields

// "205/55 r16" → "205/55R16": capitals, no spaces (the form the format check below reads)
const compactTyreSize = (raw: string) => raw.replace(/\s+/g, '').toUpperCase();
// "205/55r16" → "205/55 R16": capitals, one space before the construction letter(s) (R, ZR, RF, D, B), as the
// Tyrescart site and its CSV write them (how sizes are saved). "205/55-16" has no letter and stays as it is.
export const normalizeTyreSize = (raw: string) => compactTyreSize(raw).replace(/(\d)(ZR|RF|R|D|B)(?=\d)/, '$1 $2');
// The duplicate check's key: spacing ignored, and "31X/10.5R15" = "31X10.5R15" (flotation sizes are written both ways)
const sizeKey = (raw: string) => compactTyreSize(raw).replace(/X\//, 'X');

// Accepted formats (after normalizing), with an optional load index / speed rating at the end (91V, 121/118S):
//   metric      205/55R16, 225/45ZR17, P215/65R15, LT265/75R16, 205/65R16C, 205/55-16, 245/40RF18, 7.50/80R16
//   no aspect   195R15C, 7.50R16, 7.50-16, and truck sizes 10R22.5, 1000R22.5 (10.00), 1200R24
//   flotation   31X10.50R15, 33X12.50R20LT, 35X12.5-17, 31X/10.5R15
const LOAD_SPEED = String.raw`(\d{2,3}(\/\d{2,3})?[A-Z])?`;
const FORMATS = [
  new RegExp(String.raw`^(P|LT|ST|T)?\d{2,3}(\.\d{1,2})?\/\d{2,3}(\.\d{1,2})?(ZR|RF|R|D|B|-)\d{2}(\.\d)?(C|LT)?${LOAD_SPEED}$`),
  new RegExp(String.raw`^(\d{2,4}|\d{1,2}\.\d{1,2})(ZR|R|D|-)\d{2}(\.\d)?(C|LT)?${LOAD_SPEED}$`),
  new RegExp(String.raw`^\d{2}(\.\d)?X\/?\d{1,2}(\.\d{1,2})?(R|D|-)?\d{2}(\.\d)?(LT)?${LOAD_SPEED}$`),
];

export function validateTyreSize(raw: unknown): string {
  const compact = typeof raw === 'string' ? compactTyreSize(raw) : '';
  if (!compact) throw new AppError('Enter a tyre size', 400, 'BAD_USER_INPUT');
  if (!FORMATS.some((f) => f.test(compact)))
    throw new AppError('That doesn’t look like a tyre size. Use a format like 205/55 R16, 195 R15C or 31X10.50 R15.', 400, 'BAD_USER_INPUT');
  const size = normalizeTyreSize(compact);
  if (size.length > MAX_LENGTH) throw new AppError(`Keep the tyre size to ${MAX_LENGTH} characters or fewer`, 400, 'BAD_USER_INPUT');
  return size;
}

// { "sizes": [ … ] }; a plain array is accepted too, for a hand-made file. Hand edits that repeat a size in another
// case or spacing are shown once, as written first.
const store = jsonStore<string[]>({
  file: () => env.tyreSizesFile,
  empty: () => [],
  parse: (data) => {
    const list = Array.isArray(data) ? data : (data as { sizes?: unknown })?.sizes;
    if (!Array.isArray(list)) throw new Error('expected { "sizes": [ … ] }');
    return cleanList(list, sizeKey);
  },
  serialize: (sizes) => ({ sizes }),
  what: 'tyre size list',
  event: 'tyre_sizes',
});

// Rim size first, then width, then aspect ratio: 155/70R13 … 175/70R13 … 205/55R16 … 10R22.5. Shapes the numbers
// don't fit keep their place at the end.
const numbers = (size: string) => {
  const s = sizeKey(size).replace(/^(P|LT|ST|T)(?=\d)/, '');
  const rim = Number(/(?:ZR|RF|R|D|B|-)(\d{2}(?:\.\d)?)(?:C|LT)?(?:\d{2,3}(?:\/\d{2,3})?[A-Z])?$/.exec(s)?.[1] ?? NaN);
  const width = Number(/^\d+(?:\.\d+)?/.exec(s)?.[0] ?? NaN);
  const aspect = Number(/^[\d.]+(?:X|\/)([\d.]+)/.exec(s)?.[1] ?? 0);
  return [rim, width, aspect];
};
export function sortTyreSizes(sizes: string[]) {
  return sizes
    .map((size, i) => ({ size, i, n: numbers(size) }))
    .sort((a, b) => {
      for (let k = 0; k < 3; k++) {
        const x = a.n[k], y = b.n[k];
        if (Number.isNaN(x) !== Number.isNaN(y)) return Number.isNaN(x) ? 1 : -1;
        if (!Number.isNaN(x) && x !== y) return x - y;
      }
      return a.i - b.i;
    })
    .map((x) => x.size);
}

// Every size, in the file's order
export const listTyreSizes = () => store.read();

// Adds one size (checked, normalized) in its place in the list (rim, width, aspect). Already there (any case or spacing): DUPLICATE, and the
// message names the size as listed, so the app can choose it.
export async function addTyreSize(raw: unknown): Promise<{ size: string; sizes: string[] }> {
  const size = validateTyreSize(raw);
  const sizes = await store.update((current) => {
    const existing = current.find((s) => sizeKey(s) === sizeKey(size));
    if (existing) throw new AppError(`${existing} is already in the list`, 409, 'DUPLICATE');
    const next = sortTyreSizes([...current, size]);
    return { next, result: next };
  });
  void logEvent({ level: 'SUCCESS', category: 'system', event: 'tyre_sizes.added', message: `Tyre size ${size} added (${sizes.length} in the list)` });
  return { size, sizes };
}
