'use client';

import { useEffect, useState } from 'react';
import { LABEL_COLORS } from '@/lib/labels';

// Accepts "#25d366", "25D366" or shorthand "#2d6"; returns "#rrggbb" (lowercase) or null if it isn't a HEX colour.
// The API only stores #rrggbb, so this is what gets sent.
export function normalizeHex(input: string): string | null {
  const v = input.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{6}$/.test(v)) return `#${v}`;
  if (/^[0-9a-f]{3}$/.test(v)) return `#${[...v].map((c) => c + c).join('')}`;
  return null;
}

// Preset swatches + native colour picker + HEX text input, with a live preview of what will be saved.
// `color` is always a valid #rrggbb; `onValidChange` reports whether the typed HEX is usable.
export function ColorField({
  color,
  onChange,
  onValidChange,
  preview,
}: {
  color: string;
  onChange: (color: string) => void;
  onValidChange: (valid: boolean) => void;
  preview: (color: string) => React.ReactNode;
}) {
  const [text, setText] = useState(color);
  const valid = normalizeHex(text) !== null;

  // Keep the text box in step when a swatch or the native picker changes the colour
  useEffect(() => {
    if (normalizeHex(text) !== color) setText(color);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color]);

  useEffect(() => onValidChange(valid), [valid, onValidChange]);

  function typed(value: string) {
    setText(value);
    const hex = normalizeHex(value);
    if (hex) onChange(hex);
  }

  const isPreset = LABEL_COLORS.includes(color);

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {LABEL_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            onClick={() => onChange(c)}
            className={`h-6 w-6 rounded-full transition ${color === c ? 'ring-2 ring-primary ring-offset-2 ring-offset-surface' : 'hover:scale-110'}`}
            style={{ backgroundColor: c }}
          />
        ))}
        <label
          title="Pick a custom colour"
          className={`relative h-6 w-6 cursor-pointer overflow-hidden rounded-full border border-dashed border-line-strong ${isPreset ? '' : 'ring-2 ring-primary ring-offset-2 ring-offset-surface'}`}
          style={isPreset ? undefined : { backgroundColor: color }}
        >
          <input
            type="color"
            value={color}
            onChange={(e) => onChange(e.target.value.toLowerCase())}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
          {isPreset && (
            <span className="pointer-events-none flex h-full items-center justify-center text-[11px] text-faint">
              +
            </span>
          )}
        </label>
      </div>

      <div className="flex items-center gap-2">
        {/* Click the swatch to open the colour picker */}
        <label
          title="Open colour picker"
          className="relative h-7 w-7 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-line shadow-2xs transition hover:scale-105 hover:border-line-strong focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-1 focus-within:ring-offset-surface"
          style={{ backgroundColor: valid ? (normalizeHex(text) ?? color) : 'transparent' }}
        >
          <input
            type="color"
            aria-label="Open colour picker"
            value={color}
            onChange={(e) => onChange(e.target.value.toLowerCase())}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </label>
        <input
          value={text}
          maxLength={7}
          spellCheck={false}
          aria-label="HEX colour"
          aria-invalid={!valid}
          onChange={(e) => typed(e.target.value)}
          onBlur={() => valid && setText(normalizeHex(text)!)}
          placeholder="#25d366"
          className={`w-full rounded-lg border bg-surface-muted/70 px-3 py-1.5 font-mono text-xs text-ink-soft placeholder:text-faint outline-hidden focus:bg-surface focus:ring-1 ${valid ? 'border-line focus:border-primary focus:ring-primary' : 'border-danger-border focus:border-danger focus:ring-danger'}`}
        />
      </div>
      {!valid && <p className="text-[11px] text-danger">Enter a HEX colour like #25d366</p>}

      <div className="flex items-center gap-2 rounded-lg bg-surface-muted px-2.5 py-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-faint">Preview</span>
        <div className="min-w-0">{preview(color)}</div>
      </div>
    </div>
  );
}
