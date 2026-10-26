// Main-chunk check for the TV build (spec 2026-10-26-ui-rethink §0.3): the rare screens, and the libraries only they
// use, stay out of the start bundle that every cold launch parses and compiles. Reads the entry chunk's source map, so
// build with `vite build --sourcemap` first.
// Plain JavaScript (with chunkCheck.d.mts) so it runs without a TypeScript loader.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Modules that only lazy screens (or the worker) may pull in. Matched against '/'-separated source paths. */
export const LAZY_ONLY = [
  /\/node_modules\/saxes\//,
  /\/node_modules\/xmlchars\//,
  /\/node_modules\/qrcode-generator\//,
  /\/src\/components\/QrCode\.tsx$/,
  /\/src\/screens\/Countries\.tsx$/,
  /\/src\/screens\/Settings\.tsx$/,
  /\/src\/screens\/settings\/[A-Za-z]+Page\.tsx$/,
  /\/src\/screens\/multiview\/Multiview\.tsx$/,
];

/** The entries of `sources` that match a lazy-only pattern ('\' normalised to '/'). */
export function forbiddenSources(sources, patterns = LAZY_ONLY) {
  return sources.filter((s) => {
    const p = s.replace(/\\/g, '/');
    return patterns.some((re) => re.test(p));
  });
}

/** The entry chunk named by the build's index.html (`<script type="module" src="./assets/…js">`). */
export function mainChunkPath(distDir) {
  const html = readFileSync(join(distDir, 'index.html'), 'utf8');
  const m = /<script[^>]*type="module"[^>]*src="(?:\.\/)?(assets\/[^"]+\.js)"/.exec(html);
  if (!m) throw new Error('No module entry script in index.html');
  return join(distDir, m[1]);
}

/** Size of the entry chunk and the lazy-only modules found in it. */
export function checkMainChunk(distDir, patterns = LAZY_ONLY) {
  const chunk = mainChunkPath(distDir);
  const mapPath = `${chunk}.map`;
  if (!existsSync(mapPath)) throw new Error('No source map next to the entry chunk: build with --sourcemap');
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  return { chunk: basename(chunk), bytes: statSync(chunk).size, forbidden: forbiddenSources(map.sources ?? [], patterns) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = checkMainChunk(process.argv[2] ?? 'apps/tv/dist');
  console.log(`${r.chunk}: ${Math.round(r.bytes / 1000)} kB`);
  if (r.forbidden.length > 0) {
    console.error(`Lazy-only modules in the main chunk:\n  ${r.forbidden.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('No lazy-only modules in the main chunk.');
  }
}
