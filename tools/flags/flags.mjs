// Shared by build-flags.mjs and its test: which flags the TV ships and where they go.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The TV's flag folder (imported by apps/tv/src/assets/flags/index.ts). */
export const FLAG_DIR = resolve(ROOT, 'apps/tv/src/assets/flags');
/** Flags drawn for this project (4x3 SVGs) where flag-icons has none; read before flag-icons. */
export const EXTRA_DIR = resolve(ROOT, 'tools/flags/extra');
/** Copied into every build by Vite (public/). */
export const LICENSE_OUT = resolve(ROOT, 'apps/tv/public/licenses/flag-icons.txt');
export const FLAG_W = 96;
export const FLAG_H = 72;
/** Disputed or partially recognised territories of the detector's table: a text badge with the code, never a flag. */
export const TEXT_BADGE_COUNTRIES = new Set(['TW']);
/** The size budget of all flags together (spec: about 150 KB). */
export const FLAGS_MAX_BYTES = 200_000;
export const flagFile = (code) => `${code.toLowerCase()}.png`;
