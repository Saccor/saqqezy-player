// Startup-chunk check for the TV build (spec 2026-10-26-ui-rethink §0.3): the rare screens, and the libraries only they
// use, stay out of the start bundle that every cold launch parses and compiles. The start bundle is the entry chunk plus
// every chunk it imports statically, transitively (the bundler may move shared code into such a chunk). Reads each
// chunk's source map, so build with `vite build --sourcemap` first.
// Exit codes: 0 clean, 1 lazy-only modules found, 2 the check could not run (no entry, missing map, bad JSON).
// Plain JavaScript (with chunkCheck.d.mts) so it runs without a TypeScript loader.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * Relative chunk specifiers a built chunk imports statically: `import … from "./x.js"`, `import "./x.js"` and
 * `export … from "./x.js"`. Dynamic `import("./x.js")` (a lazy chunk) is not matched.
 */
export function staticImports(code) {
  const out = [];
  const re = /(?:\bfrom|\bimport)\s*["'](\.\.?\/[^"']+\.js)["']/g;
  for (let m = re.exec(code); m; m = re.exec(code)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** The entry chunk and every chunk it imports statically, transitively (entry first, each chunk once). */
export function startupChunks(distDir) {
  const seen = [];
  const visit = (path) => {
    if (seen.includes(path)) return;
    if (!existsSync(path)) throw new Error(`Startup chunk not found: ${basename(path)}`);
    seen.push(path);
    for (const spec of staticImports(readFileSync(path, 'utf8'))) visit(join(dirname(path), spec));
  };
  visit(mainChunkPath(distDir));
  return seen;
}

function chunkSources(chunk) {
  const mapPath = `${chunk}.map`;
  if (!existsSync(mapPath)) throw new Error(`No source map next to ${basename(chunk)}: build with --sourcemap`);
  let map;
  try {
    map = JSON.parse(readFileSync(mapPath, 'utf8'));
  } catch (err) {
    throw new Error(`Bad source map JSON for ${basename(chunk)}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return map.sources ?? [];
}

/** Size of the entry chunk and the lazy-only modules found in it. */
export function checkMainChunk(distDir, patterns = LAZY_ONLY) {
  const chunk = mainChunkPath(distDir);
  return { chunk: basename(chunk), bytes: statSync(chunk).size, forbidden: forbiddenSources(chunkSources(chunk), patterns) };
}

/** The whole start bundle: entry size, total size of all startup chunks, and lazy-only modules in any of them. */
export function checkStartup(distDir, patterns = LAZY_ONLY) {
  const chunks = startupChunks(distDir).map((path) => ({
    chunk: basename(path), bytes: statSync(path).size, forbidden: forbiddenSources(chunkSources(path), patterns),
  }));
  return {
    chunk: chunks[0].chunk,
    bytes: chunks[0].bytes,
    totalBytes: chunks.reduce((n, c) => n + c.bytes, 0),
    chunks: chunks.map(({ chunk, bytes }) => ({ chunk, bytes })),
    forbidden: chunks.flatMap((c) => c.forbidden.map((source) => ({ chunk: c.chunk, source }))),
  };
}

/** True when `argv1` is this module run as a script: compares real paths, ignoring case on Windows (drive letters). */
export function isMainModule(argv1, metaUrl) {
  if (!argv1) return false;
  try {
    const a = realpathSync(argv1);
    const b = realpathSync(fileURLToPath(metaUrl));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  try {
    const r = checkStartup(process.argv[2] ?? 'apps/tv/dist');
    const kb = (n) => `${Math.round(n / 1000)} kB`;
    console.log(`${r.chunk}: ${kb(r.bytes)}`);
    console.log(`Startup total: ${kb(r.totalBytes)} in ${r.chunks.length} chunks (${r.chunks.map((c) => `${c.chunk} ${kb(c.bytes)}`).join(', ')})`);
    if (r.forbidden.length > 0) {
      console.error(`Lazy-only modules in the startup chunks:\n  ${r.forbidden.map((f) => `${f.chunk}: ${f.source}`).join('\n  ')}`);
      process.exitCode = 1;
    } else {
      console.log('No lazy-only modules in the startup chunks.');
    }
  } catch (err) {
    console.error(`Chunk check could not run: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  }
}
