'use client';

import { useEffect } from 'react';
import { polyfillCountryFlagEmojis } from 'country-flag-emoji-polyfill';

// Chrome and Edge on Windows draw flag emojis (🇮🇳) as two letters ("IN"). There, this adds a font that covers only
// the flag characters, served from our own /fonts; everywhere else the browser's flags already work and it does nothing.
export function FlagEmojis({ font }: { font: string }) {
  useEffect(() => {
    polyfillCountryFlagEmojis(font, '/fonts/TwemojiCountryFlags.woff2');
  }, [font]);
  return null;
}
