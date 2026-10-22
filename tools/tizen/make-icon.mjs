// Draws the Tizen app icon: the Saqqezy Player mark on its opaque tile, 512x423 24-bit PNG (Samsung's launcher and
// Seller Office size). The geometry lives in tools/brand/mark.mjs; `pnpm brand:export` writes every platform size.
// Usage: node tools/tizen/make-icon.mjs [out.png]   (default: apps/tv/tizen/icon.png)
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND, renderPng } from '../brand/mark.mjs';

export function makeIconPng() {
  return renderPng({ width: 512, height: 423, background: BRAND.tile });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const out = resolve(process.argv[2] ?? resolve(root, 'apps/tv/tizen/icon.png'));
  writeFileSync(out, makeIconPng());
  console.log(`Wrote ${out}`);
}
