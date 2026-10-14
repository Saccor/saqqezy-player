import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * API-floor guard. The TV build targets Chromium 76 (Tizen 6.0 / webOS), so production code must not use
 * newer runtime APIs. See "API floor" in apps/tv/STACK.md. Add `// tv-floor-ok` to a line to allow a
 * reviewed exception (for example a feature-detected use). Comments are stripped first (`stripComments`), so they
 * may mention banned names.
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
  { name: 'crypto.randomUUID( (Chromium 92)', re: /\bcrypto\.randomUUID\s*\(/ },
  { name: 'TextDecoderStream (use TextDecoder with stream: true)', re: /\bTextDecoderStream\b/ },
];

/**
 * Blanks every comment (line and block, also across lines) so prose can mention banned names. Newlines are kept,
 * so line numbers stay right. Quotes and template literals are skipped as code, so a `/*` inside a string (a glob,
 * a URL) does not start a comment. Regex literals are not recognised; the integrity test below fails if one ever
 * makes the stripper swallow code.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      const start = i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') i++;
        else if (c !== '`' && src[i] === '\n') break;
        i++;
      }
      i++;
      out += src.slice(start, Math.min(i, n));
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

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
      const source = readFileSync(f, 'utf8');
      const lines = source.split(/\r?\n/);
      // Comments (line and block) may mention banned names; only code counts.
      stripComments(source).split(/\r?\n/).forEach((code, i) => {
        const line = lines[i] ?? '';
        if (line.includes('tv-floor-ok')) return;
        for (const b of BANNED) if (b.re.test(code)) violations.push(`${rel}:${i + 1}  ${b.name}  ${line.trim().slice(0, 100)}`);
      });
    }
    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });

  test('comment stripping keeps every file intact: same line count, and a call planted at the end is still seen', () => {
    for (const f of files) {
      const source = readFileSync(f, 'utf8');
      const stripped = stripComments(`${source}\nstructuredClone(planted);\n`).split(/\r?\n/);
      expect(stripped.length, f).toBe(source.split(/\r?\n/).length + 2);
      expect(stripped[stripped.length - 2], f).toBe('structuredClone(planted);');
    }
  });

  test('the matcher catches each banned API', () => {
    const samples = [
      'structuredClone(x)', 'Object.hasOwn(a, b)', 's.replaceAll("a", "b")', 'a.findLast(f)', 'a.findLastIndex(f)', 'a.at(-1)',
      'a.toSorted()', 'a.toReversed()', 'a.toSpliced(0, 1)', 'a.with(0, 1)', 'AbortSignal.any([])', 'AbortSignal.timeout(5)',
      'Promise.any(p)', 'new WeakRef(o)', 'Object.groupBy(a, f)', 'crypto.randomUUID()', 'self.crypto.randomUUID()',
      'new TextDecoderStream()', 'body.pipeThrough(new TextDecoderStream("utf-8"))',
    ];
    for (const s of samples) expect(BANNED.some((b) => b.re.test(s)), s).toBe(true);
  });
});

describe('stripComments (API-floor scanner)', () => {
  test('block comments, also across lines, and line comments are blanked; line numbers stay', () => {
    const src = [
      'const a = 1; /* structuredClone(x) */ const b = 2;',
      '/**',
      ' * Uses crypto.randomUUID() on newer engines.',
      ' */',
      'const c = 3; // new TextDecoderStream()',
      'f(); /* start',
      '  a.at(-1) */ g();',
    ].join('\n');
    const out = stripComments(src);
    expect(out.split('\n')).toHaveLength(7);
    for (const b of BANNED) expect(b.re.test(out), b.name).toBe(false);
    expect(out).toContain('const b = 2;');
    expect(out).toContain('const c = 3;');
    expect(out.split('\n')[6]).toContain('g();');
  });

  test('comment markers inside strings are code, not comments', () => {
    const src = [
      "const glob = 'src/**/*.ts'; structuredClone(x);",
      'const url = "http://example.test"; a.at(-1);',
      'const t = `/* ${v} */`; crypto.randomUUID();',
    ].join('\n');
    const lines = stripComments(src).split('\n');
    expect(BANNED.some((b) => b.re.test(lines[0]!))).toBe(true);
    expect(BANNED.some((b) => b.re.test(lines[1]!))).toBe(true);
    expect(BANNED.some((b) => b.re.test(lines[2]!))).toBe(true);
  });
});
