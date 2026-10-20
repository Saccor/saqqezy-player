/**
 * Token lint (UI revamp spec §1.1): counts design literals per source file. The test compares the counts with
 * `tokenLint.baseline.json` and fails when a file gains any, so the baseline can only shrink.
 * Rewrite the baseline after removing literals: `pnpm exec tsx apps/tv/src/shell/tokenLint.ts --write`.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TokenCounts { colour: number; fontSize: number; scale: number }

const COLOUR = /0x[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b/g;
/** A `fontSize={…}` expression (no nested braces), and the numeric literals inside one (`a ? 36 : TYPE.title`). */
const FONT_SIZE = /fontSize=\{([^{}]*)\}/g;
const NUMBER = /(?<![\w.])\d+(?:\.\d+)?/g;
const SCALE = /scale=\{[^}]*\b1\.\d+/g;
/** Files where literals belong, or that are not UI. */
// components/QrCode.tsx: scanners need pure white and black modules, so it keeps its literals.
const SKIP = new Set(['shell/theme.ts', 'shell/tokenLint.ts', 'shell/contrast.ts', 'components/QrCode.tsx']);

export function countTokens(text: string): TokenCounts {
  return {
    colour: text.match(COLOUR)?.length ?? 0,
    fontSize: [...text.matchAll(FONT_SIZE)].reduce((n, m) => n + (m[1]?.match(NUMBER)?.length ?? 0), 0),
    scale: text.match(SCALE)?.length ?? 0,
  };
}

export function scanTokens(root: string): Record<string, TokenCounts> {
  const out: Record<string, TokenCounts> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== 'dev') walk(p); continue; }
      if (!/\.tsx?$/.test(name) || name.endsWith('.test.ts')) continue;
      const rel = relative(root, p).replace(/\\/g, '/');
      if (SKIP.has(rel)) continue;
      const c = countTokens(readFileSync(p, 'utf8'));
      if (c.colour + c.fontSize + c.scale > 0) out[rel] = c;
    }
  };
  walk(root);
  return out;
}

if (process.argv.includes('--write')) {
  const here = dirname(fileURLToPath(import.meta.url));
  const counts = scanTokens(join(here, '..'));
  const sorted = Object.fromEntries(Object.keys(counts).sort().map((k) => [k, counts[k]]));
  writeFileSync(join(here, 'tokenLint.baseline.json'), `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`tokenLint: baseline written for ${Object.keys(sorted).length} files`);
}
