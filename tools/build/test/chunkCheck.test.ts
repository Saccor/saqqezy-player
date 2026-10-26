import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkMainChunk, checkStartup, forbiddenSources, isMainModule, mainChunkPath, staticImports, startupChunks } from '../chunkCheck.mjs';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function dist(sources: string[], html = '<script type="module" crossorigin src="./assets/index-abc.js"></script>'): string {
  const d = mkdtempSync(join(tmpdir(), 'chunk-'));
  dirs.push(d);
  mkdirSync(join(d, 'assets'));
  writeFileSync(join(d, 'index.html'), `<!doctype html><html><head>${html}</head><body></body></html>`);
  writeFileSync(join(d, 'assets', 'index-abc.js'), 'x'.repeat(1234));
  writeFileSync(join(d, 'assets', 'index-abc.js.map'), JSON.stringify({ version: 3, sources }));
  return d;
}

describe('forbiddenSources', () => {
  it('flags the XMLTV parser, the QR library and the rare screens, with either slash style', () => {
    const hits = forbiddenSources([
      '../../../../node_modules/.pnpm/saxes@6.0.0/node_modules/saxes/saxes.js',
      '..\\..\\node_modules\\.pnpm\\qrcode-generator@2.0.4\\node_modules\\qrcode-generator\\dist\\qrcode.mjs',
      '../../src/screens/Settings.tsx',
      '../../src/screens/settings/StoragePage.tsx',
      '../../src/screens/multiview/Multiview.tsx',
      '../../src/screens/Countries.tsx',
      '../../src/components/QrCode.tsx',
    ]);
    expect(hits).toHaveLength(7);
  });

  it('keeps what the first frame needs (AddSource is the first-run screen), and helpers the rare screens share with it', () => {
    expect(forbiddenSources([
      '../../src/screens/live/LiveTv.tsx',
      '../../src/screens/Player.tsx',
      '../../src/screens/AddSource.tsx',
      '../../src/screens/multiview/windows.ts',
      '../../src/screens/settings/backupLogic.ts',
      '../../src/screens/addSourceLogic.ts',
      '../../src/screens/countriesLogic.ts',
    ])).toEqual([]);
  });
});

describe('checkMainChunk', () => {
  it('finds the entry chunk from index.html and reports its size and lazy-only sources', () => {
    const d = dist(['../../src/main.tsx', '../../src/screens/Settings.tsx']);
    expect(mainChunkPath(d)).toBe(join(d, 'assets', 'index-abc.js'));
    expect(checkMainChunk(d)).toEqual({ chunk: 'index-abc.js', bytes: 1234, forbidden: ['../../src/screens/Settings.tsx'] });
  });

  it('fails clearly without an entry script or a source map', () => {
    expect(() => mainChunkPath(dist([], '<script src="x.js"></script>'))).toThrow('No module entry script');
    const d = dist([]);
    rmSync(join(d, 'assets', 'index-abc.js.map'));
    expect(() => checkMainChunk(d)).toThrow('--sourcemap');
  });
});

/** A build with several chunks: name -> [code, sources]. 'index-abc.js' is the entry. */
function multi(chunks: Record<string, [string, string[]]>): string {
  const d = dist([]);
  for (const [name, [code, sources]] of Object.entries(chunks)) {
    writeFileSync(join(d, 'assets', name), code);
    writeFileSync(join(d, 'assets', `${name}.map`), JSON.stringify({ version: 3, sources }));
  }
  return d;
}

describe('staticImports', () => {
  it('reads minified static imports and re-exports, never dynamic imports', () => {
    const code = 'import{a as b}from"./shared-1.js";import"./side-2.js";export{c}from"./re-3.js";const s=()=>import("./Settings-4.js");';
    expect(staticImports(code)).toEqual(['./shared-1.js', './side-2.js', './re-3.js']);
  });

  it('reads star re-exports', () => {
    expect(staticImports(`export*from"./star-5.js";export * from './star-6.js';`)).toEqual(['./star-5.js', './star-6.js']);
  });
});

describe('checkStartup', () => {
  const entry = 'import{x}from"./Toast-t.js";const s=()=>import("./Settings-s.js");';

  it('covers the entry and every chunk it imports statically, transitively, but not lazy chunks', () => {
    const d = multi({
      'index-abc.js': [entry, ['../../src/main.tsx']],
      'Toast-t.js': ['import"./deep-d.js";', ['../../src/shell/Toast.tsx']],
      'deep-d.js': ['export const y=1;', ['../../src/shell/theme.ts']],
      'Settings-s.js': ['import{x}from"./Toast-t.js";', ['../../src/screens/Settings.tsx']],
    });
    expect(startupChunks(d).map((p) => relative(d, p).split(sep).join('/'))).toEqual(['assets/index-abc.js', 'assets/Toast-t.js', 'assets/deep-d.js']);
    const r = checkStartup(d);
    expect(r.forbidden).toEqual([]);
    expect(r.chunk).toBe('index-abc.js');
    expect(r.bytes).toBe(entry.length);
    expect(r.totalBytes).toBe(entry.length + 'import"./deep-d.js";'.length + 'export const y=1;'.length);
  });

  it('catches a lazy-only module in a static child chunk', () => {
    const d = multi({
      'index-abc.js': [entry, ['../../src/main.tsx']],
      'Toast-t.js': ['import"./deep-d.js";', ['../../src/shell/Toast.tsx']],
      'deep-d.js': ['export const y=1;', ['../../src/components/QrCode.tsx']],
    });
    expect(checkStartup(d).forbidden).toEqual([{ chunk: 'deep-d.js', source: '../../src/components/QrCode.tsx' }]);
  });

  it('fails clearly when a startup chunk has no source map or is missing', () => {
    const d = multi({ 'index-abc.js': [entry, []], 'Toast-t.js': ['', []] });
    rmSync(join(d, 'assets', 'Toast-t.js.map'));
    expect(() => checkStartup(d)).toThrow('--sourcemap');
    rmSync(join(d, 'assets', 'Toast-t.js'));
    expect(() => checkStartup(d)).toThrow('Toast-t.js');
  });
});

describe('isMainModule', () => {
  it('matches the script through realpath, ignoring drive-letter case on Windows', () => {
    const d = dist([]);
    const file = join(d, 'assets', 'index-abc.js');
    const url = pathToFileURL(realpathSync(file)).href;
    expect(isMainModule(file, url)).toBe(true);
    if (process.platform === 'win32') {
      const flipped = file.replace(/^[a-z]/i, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
      expect(isMainModule(flipped, url)).toBe(true);
    }
    expect(isMainModule(join(d, 'index.html'), url)).toBe(false);
    expect(isMainModule(undefined, url)).toBe(false);
  });
});
