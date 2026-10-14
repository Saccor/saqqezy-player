import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * API-floor guard. The TV build targets Chromium 76 (Tizen 6.0 / webOS), so production code must not use
 * newer runtime APIs. See "API floor" in apps/tv/STACK.md. Add `// tv-floor-ok` to a line to allow a
 * reviewed exception (for example a feature-detected use).
 *
 * Not scanned: tests, `memoryStorage.ts` (test helper), `apps/tv/src/dev/`, and `apps/companion` and
 * `services/relay`, which run on phones and servers, never on a TV.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const BANNED: { name: string; re: RegExp }[] = [
  { name: 'structuredClone(', re: /\bstructuredClone\s*\(/ },
  { name: 'Object.hasOwn(', re: /\bObject\.hasOwn\s*\(/ },
  { name: '.replaceAll(', re: /\.replaceAll\s*\(/ },
  { name: '.findLast(', re: /\.findLast\s*\(/ },
  { name: '.findLastIndex(', re: /\.findLastIndex\s*\(/ },
  { name: '.at( (use [i] or [length - 1])', re: /\.at\(/ },
  { name: '.toSorted(', re: /\.toSorted\s*\(/ },
  { name: '.toReversed(', re: /\.toReversed\s*\(/ },
  { name: '.toSpliced(', re: /\.toSpliced\s*\(/ },
  { name: '.with(', re: /\.with\s*\(/ },
  { name: 'AbortSignal.any(', re: /\bAbortSignal\.any\s*\(/ },
  { name: 'AbortSignal.timeout(', re: /\bAbortSignal\.timeout\s*\(/ },
  { name: 'Promise.any(', re: /\bPromise\.any\s*\(/ },
  { name: 'WeakRef', re: /\bWeakRef\b/ },
  { name: 'Object.groupBy(', re: /\bObject\.groupBy\s*\(/ },
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-tizen', 'dist-webos', '.git']);

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir).map((n) => join(dir, n)).filter((p) => statSync(p).isDirectory());
  } catch { return []; }
}

function roots(): string[] {
  const out: string[] = [join(ROOT, 'apps', 'tv', 'src')];
  for (const base of ['packages', 'services']) {
    for (const d of subdirs(join(ROOT, base))) {
      if (base === 'services' && d.endsWith(`${sep}relay`)) continue; // server, not a TV
      out.push(join(d, 'src'));
    }
  }
  return out;
}

function walk(dir: string, out: string[]): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(n)) walk(p, out);
    } else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(p);
  }
}

function productionFiles(): string[] {
  const files: string[] = [];
  for (const r of roots()) walk(r, files);
  return files.filter((f) => {
    const rel = relative(ROOT, f).split(sep).join('/');
    return rel !== 'packages/storage/src/memoryStorage.ts' && !rel.startsWith('apps/tv/src/dev/')
      && !rel.startsWith('apps/companion/') && !rel.startsWith('services/relay/');
  });
}

describe('TV API floor (Chromium 76)', () => {
  const files = productionFiles();

  test('scans production sources', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith(`${sep}ops.ts`))).toBe(true);
  });

  test('no production file uses an API newer than Chromium 76', () => {
    const violations: string[] = [];
    for (const f of files) {
      const rel = relative(ROOT, f).split(sep).join('/');
      readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (line.includes('tv-floor-ok')) return;
        const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, ''); // whole-line comments may mention banned names
        for (const b of BANNED) if (b.re.test(code)) violations.push(`${rel}:${i + 1}  ${b.name}  ${line.trim().slice(0, 100)}`);
      });
    }
    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });

  test('the matcher catches each banned API', () => {
    const samples = [
      'structuredClone(x)', 'Object.hasOwn(a, b)', 's.replaceAll("a", "b")', 'a.findLast(f)', 'a.findLastIndex(f)', 'a.at(-1)',
      'a.toSorted()', 'a.toReversed()', 'a.toSpliced(0, 1)', 'a.with(0, 1)', 'AbortSignal.any([])', 'AbortSignal.timeout(5)',
      'Promise.any(p)', 'new WeakRef(o)', 'Object.groupBy(a, f)',
    ];
    for (const s of samples) expect(BANNED.some((b) => b.re.test(s)), s).toBe(true);
  });
});
