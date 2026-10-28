// Writes the Saqqezy Player mark's SVG masters and every platform PNG (sizes and uses are listed below).
// Usage: node tools/brand/export.mjs   (or pnpm brand:export)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND, markSvg, renderPng, tileSvg } from './mark.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const brand = resolve(root, 'apps/tv/brand');
mkdirSync(brand, { recursive: true });

const write = (path, data) => {
  writeFileSync(path, data);
  console.log(`Wrote ${relative(root, path)}`);
};
const png = (name, width, height, background, markScale) =>
  write(resolve(brand, name), renderPng({ width, height, background, markScale }));

write(resolve(brand, 'mark.svg'), markSvg());
write(resolve(brand, 'tile.svg'), tileSvg());
// Samsung: config.xml icon / Seller Office small icon, plus the 1920x1080 logo and background layers.
write(resolve(root, 'apps/tv/tizen/icon.png'), renderPng({ width: 512, height: 423, background: BRAND.tile }));
png('samsung-logo-1920x1080.png', 1920, 1080, undefined, 0.5);
png('samsung-background-1920x1080.png', 1920, 1080, BRAND.tile, 0);
// LG webOS: appinfo.json icon, largeIcon and splashBackground; Seller Lounge store icon.
png('webos-icon-80.png', 80, 80, BRAND.tile, 0.66);
png('webos-largeicon-130.png', 130, 130, BRAND.tile, 0.66);
png('webos-splash-1920x1080.png', 1920, 1080, BRAND.tile, 0.3);
png('store-icon-400.png', 400, 400, BRAND.tile, 0.62);
// Generic square: the Android TV launcher source and anything else that wants one.
png('icon-512.png', 512, 512, BRAND.tile, 0.62);
// Site favicon: a rounded tile, so it reads on light and dark browser tabs.
write(resolve(root, 'apps/site/public/favicon.svg'),
  tileSvg({ width: 64, height: 64, markScale: 0.72 }).replace('<rect ', '<rect rx="14" '));
