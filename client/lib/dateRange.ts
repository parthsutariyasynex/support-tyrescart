// Date-range picker helpers. Days are local calendar days as yyyy-mm-dd strings.

export type Preset = 'today' | 'yesterday' | 'last7' | 'last30' | 'custom';
export const PRESETS: { key: Preset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 days' },
  { key: 'last30', label: 'Last 30 days' },
  { key: 'custom', label: 'Custom date' },
];

const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

// The from/to days a preset stands for, relative to `now` (custom: none)
export function presetRange(p: Preset, now = new Date()): { from: string; to: string } | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (p === 'today') return { from: ymd(today), to: ymd(today) };
  if (p === 'yesterday') return { from: ymd(addDays(today, -1)), to: ymd(addDays(today, -1)) };
  if (p === 'last7') return { from: ymd(addDays(today, -6)), to: ymd(today) };
  if (p === 'last30') return { from: ymd(addDays(today, -29)), to: ymd(today) };
  return null;
}

// Which preset (if any) a from/to pair matches; anything else is custom
export function matchPreset(from: string, to: string, now = new Date()): Preset | null {
  if (!from && !to) return null;
  for (const p of ['today', 'yesterday', 'last7', 'last30'] as const) {
    const r = presetRange(p, now)!;
    if (r.from === from && r.to === to) return p;
  }
  return 'custom';
}

// Month grid, weeks starting on Sunday; days outside the month are null
export function monthGrid(year: number, month: number): (string | null)[][] {
  const first = new Date(year, month, 1);
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (string | null)[] = Array(first.getDay()).fill(null);
  for (let d = 1; d <= days; d++) cells.push(ymd(new Date(year, month, d)));
  while (cells.length % 7) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

// Clicking a day while picking: first click starts a range, second click ends it (in either order); a third starts over
export function pickDay(range: { from: string; to: string }, day: string): { from: string; to: string } {
  if (!range.from || range.to) return { from: day, to: '' };
  return day < range.from ? { from: day, to: range.from } : { from: range.from, to: day };
}

export const inRange = (day: string, from: string, to: string) => !!from && !!to && day >= from && day <= to;
