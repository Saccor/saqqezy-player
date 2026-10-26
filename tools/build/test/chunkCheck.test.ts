import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkMainChunk, forbiddenSources, mainChunkPath } from '../chunkCheck.mjs';

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
