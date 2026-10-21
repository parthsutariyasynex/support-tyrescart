'use client';

import { useState } from 'react';
import { type Preset, PRESETS, inRange, matchPreset, monthGrid, parseYmd, pickDay, presetRange, todayYmd } from '@/lib/dateRange';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

// "Date range" in the Filter menu: presets on the left, a month calendar on the right, Clear / Apply filter below.
// Nothing changes the list until Apply filter.
export function DateRangePanel({
  from,
  to,
  onApply,
}: {
  from: string;
  to: string;
  onApply: (range: { from: string; to: string }) => void;
}) {
  const today = todayYmd(); // in Dubai
  const [draft, setDraft] = useState({ from, to });
  const [preset, setPreset] = useState<Preset | null>(matchPreset(from, to));
  const start = parseYmd(draft.from || today);
  const [view, setView] = useState({ year: start.getUTCFullYear(), month: start.getUTCMonth() });
  const thisYear = Number(today.slice(0, 4));
  const thisMonth = Number(today.slice(5, 7)) - 1;
  const atCurrentMonth = view.year === thisYear && view.month === thisMonth;
  const ready = !!draft.from && !!draft.to;

  function choosePreset(p: Preset) {
    setPreset(p);
    const r = presetRange(p);
    if (r) {
      setDraft(r);
      const d = parseYmd(r.from);
      setView({ year: d.getUTCFullYear(), month: d.getUTCMonth() });
    } else setDraft({ from: '', to: '' }); // custom: pick on the calendar
  }

  function shiftMonth(delta: number) {
    setView((v) => {
      const d = new Date(Date.UTC(v.year, v.month + delta, 1));
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
    });
  }

  const select = 'cursor-pointer appearance-none bg-transparent pr-3 text-[13px] font-medium text-body outline-none';

  return (
    <div className="ml-1 w-[34rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-line bg-surface shadow-xl">
      <div className="flex">
        <div className="w-40 shrink-0 border-r border-line-soft p-2">
          <p className="px-2.5 pb-1.5 pt-1 text-[10px] font-bold uppercase tracking-wider text-faint">Date range</p>
          <ul>
            {PRESETS.map((p) => (
              <li key={p.key}>
                <button
                  type="button"
                  aria-pressed={preset === p.key}
                  onClick={() => choosePreset(p.key)}
                  className={`w-full rounded-lg px-2.5 py-1.5 text-left text-[13px] text-body hover:bg-surface-muted ${preset === p.key ? 'bg-surface-muted font-medium' : ''}`}
                >
                  {p.label}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex-1 p-3">
          <div className="mb-2 flex items-center justify-between">
            <button type="button" aria-label="Previous month" onClick={() => shiftMonth(-1)} className="rounded-md p-1 text-body hover:bg-surface-muted">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
            <div className="flex items-center gap-3">
              <select aria-label="Month" value={view.month} onChange={(e) => setView((v) => ({ ...v, month: Number(e.target.value) }))} className={select}>
                {MONTHS.map((m, i) => (
                  <option key={m} value={i} disabled={view.year === thisYear && i > thisMonth}>
                    {m}
                  </option>
                ))}
              </select>
              <select aria-label="Year" value={view.year} onChange={(e) => setView((v) => ({ ...v, year: Number(e.target.value) }))} className={select}>
                {Array.from({ length: 6 }, (_, i) => thisYear - 5 + i).map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </div>
            <button type="button" aria-label="Next month" disabled={atCurrentMonth} onClick={() => shiftMonth(1)} className="rounded-md p-1 text-body hover:bg-surface-muted disabled:opacity-30">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          </div>

          <table className="w-full table-fixed text-center text-[12px]">
            <thead>
              <tr className="text-muted">
                {WEEKDAYS.map((d) => (
                  <th key={d} className="pb-1.5 font-medium">
                    {d}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {monthGrid(view.year, view.month).map((week, i) => (
                <tr key={i}>
                  {week.map((day, j) => {
                    if (!day) return <td key={j} />;
                    const future = day > today;
                    const edge = day === draft.from || day === draft.to;
                    const within = inRange(day, draft.from, draft.to);
                    return (
                      <td key={j} className="py-0.5">
                        <button
                          type="button"
                          disabled={future}
                          aria-label={day}
                          aria-pressed={edge || within}
                          onClick={() => {
                            setPreset('custom');
                            setDraft((r) => pickDay(r, day));
                          }}
                          className={`mx-auto flex h-8 w-8 items-center justify-center rounded-full transition ${
                            edge
                              ? 'bg-primary font-semibold text-on-primary'
                              : within
                                ? 'bg-primary-subtle text-primary'
                                : future
                                  ? 'cursor-default text-faint'
                                  : 'text-body hover:bg-surface-muted'
                          } ${day === today && !edge ? 'ring-1 ring-body' : ''}`}
                        >
                          {Number(day.slice(8))}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-line-soft px-4 py-2.5">
        <button
          type="button"
          disabled={!draft.from && !from}
          onClick={() => {
            setDraft({ from: '', to: '' });
            setPreset(null);
            onApply({ from: '', to: '' });
          }}
          className="rounded-lg px-3 py-1.5 text-xs font-medium text-body-soft hover:bg-surface-muted disabled:opacity-40"
        >
          Clear
        </button>
        <span className="text-[11px] text-muted">{draft.from ? (draft.to ? (draft.from === draft.to ? draft.from : `${draft.from} → ${draft.to}`) : `${draft.from} → pick an end day`) : ''}</span>
        <button
          type="button"
          disabled={!ready}
          onClick={() => onApply(draft)}
          className="rounded-lg bg-primary px-4 py-1.5 text-xs font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-40"
        >
          Apply filter
        </button>
      </div>
    </div>
  );
}
