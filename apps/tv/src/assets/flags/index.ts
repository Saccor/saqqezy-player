/**
 * Flag images for Your countries' grid and the "Other countries" list only (spec 2026-10-22-your-countries-flags):
 * 96 x 72 PNGs written by tools/flags/build-flags.mjs from flag-icons (MIT, licence in public/licenses). The glob is
 * resolved at build time; `?no-inline` keeps every flag a file in the package (never base64 in the bundle), so a
 * texture loads only for a chip or row on screen. Disputed territories and language keys have no file (text badge).
 */
const FILES = import.meta.glob<string>('./*.png', { eager: true, query: '?no-inline', import: 'default' });

/** The flag image of a country key ("SE"); undefined for a `lang:` key, a disputed territory or a missing file. */
export function flagFor(key: string): string | undefined {
  if (!/^[A-Z]{2}$/.test(key)) return undefined;
  return FILES[`./${key.toLowerCase()}.png`];
}
