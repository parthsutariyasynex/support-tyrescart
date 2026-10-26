// How a location message is stored (no new database fields): type "location", and a text that reads on its own
// (search, copy, chat list) and holds the exact coordinates on its last line, as a Google Maps link:
//   📍 Al Quoz Tyre Centre
//   Street 4a, Al Quoz 3, Dubai
//   https://maps.google.com/?q=25.123456,55.234567
// The web app reads the same format (client/lib/location.ts). Pure functions only, so anything can import them.

export type Place = { latitude: number; longitude: number; name?: string | null; address?: string | null };

const COORDS_LINE = /^https:\/\/maps\.google\.com\/\?q=(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/;
export const roundCoord = (n: number) => Math.round(n * 1e6) / 1e6; // ~0.1 m: as exact as a phone's GPS
export const oneLine = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

export const validCoords = (lat: number, lng: number) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

// The stored text of a location message
export function locationBody(p: Place) {
  const name = oneLine(p.name);
  const address = oneLine(p.address);
  return [name && `📍 ${name}`, address, `https://maps.google.com/?q=${roundCoord(p.latitude)},${roundCoord(p.longitude)}`].filter(Boolean).join('\n');
}

// Back from the stored text (null: not a location with coordinates, e.g. an old "[location]")
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

// A location in an incoming webhook message (msg.location); null when its coordinates are missing or invalid
export function placeFromWebhook(loc: any): Place | null {
  const latitude = Number(loc?.latitude);
  const longitude = Number(loc?.longitude);
  if (loc?.latitude === undefined || loc?.longitude === undefined || !validCoords(latitude, longitude)) return null;
  return { latitude, longitude, name: typeof loc.name === 'string' ? loc.name : null, address: typeof loc.address === 'string' ? loc.address : null };
}
