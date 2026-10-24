// Rasterises the flag-icons 4x3 SVGs (MIT) of the region detector's countries to 96x72 PNGs for the TV's country grid
// (spec 2026-10-22-your-countries-flags). PNG, not SVG: Chromium 76 TVs must never decode an SVG at run time.
// Usage: pnpm flags:build   (node --import tsx tools/flags/build-flags.mjs). Commit the output; builds never run this.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { knownCountries } from '../../packages/core/src/text/regions.ts';
import { EXTRA_DIR, FLAG_DIR, FLAG_W, FLAGS_MAX_BYTES, LICENSE_OUT, ROOT, TEXT_BADGE_COUNTRIES, flagFile } from './flags.mjs';

const pkg = resolve(ROOT, 'node_modules/flag-icons');
mkdirSync(FLAG_DIR, { recursive: true });
for (const f of readdirSync(FLAG_DIR)) if (f.endsWith('.png')) rmSync(join(FLAG_DIR, f));
let total = 0;
for (const code of knownCountries()) {
  if (TEXT_BADGE_COUNTRIES.has(code)) continue;
  // Our own drawing first (flags flag-icons does not have, such as Kurdistan), else flag-icons.
  const own = join(EXTRA_DIR, `${code.toLowerCase()}.svg`);
  const svg = readFileSync(existsSync(own) ? own : join(pkg, 'flags/4x3', `${code.toLowerCase()}.svg`), 'utf8');
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: FLAG_W }, font: { loadSystemFonts: false } }).render().asPng();
  writeFileSync(join(FLAG_DIR, flagFile(code)), png);
  total += png.length;
}
mkdirSync(dirname(LICENSE_OUT), { recursive: true });
copyFileSync(join(pkg, 'LICENSE'), LICENSE_OUT);
console.log(`Wrote ${knownCountries().length - TEXT_BADGE_COUNTRIES.size} flags to ${relative(ROOT, FLAG_DIR)} (${total} bytes) and ${relative(ROOT, LICENSE_OUT)}.`);
if (total >= FLAGS_MAX_BYTES) {
  console.error(`Flags total ${total} bytes: over the ${FLAGS_MAX_BYTES} byte budget.`);
  process.exit(1);
}
