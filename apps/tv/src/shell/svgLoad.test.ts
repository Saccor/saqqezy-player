import { describe, expect, test } from 'vitest';
import { loadSvgCors, svgCrossOrigin, type SvgDeps } from './svgLoad.ts';

describe('svgCrossOrigin', () => {
  test('http(s) and relative URLs ask for CORS; data: and blob: never need it', () => {
    expect(svgCrossOrigin('http://127.0.0.1:8899/poster/m1.svg')).toBe('anonymous');
    expect(svgCrossOrigin('https://example.test/logo.svg')).toBe('anonymous');
    expect(svgCrossOrigin('/__proxy/raw?u=x.svg')).toBe('anonymous');
    expect(svgCrossOrigin('data:image/svg+xml;base64,AAAA')).toBeUndefined();
    expect(svgCrossOrigin('BLOB:http://x/1')).toBeUndefined();
  });
});

/** A fake Image and 2D canvas: records the order of `crossOrigin` and `src`, and what was drawn. */
function fakeDeps() {
  const log: string[] = [];
  const img = {
    width: 40, height: 60, onload: null as null | (() => void), onerror: null as null | ((e: unknown) => void),
    set crossOrigin(v: string) { log.push(`crossOrigin=${v}`); },
    set src(v: string) { log.push(`src=${v}`); },
  };
  const ctx = {
    imageSmoothingEnabled: false,
    drawImage: (_i: unknown, x: number, y: number, w: number, h: number) => log.push(`draw ${x},${y},${w}x${h}`),
    getImageData: (x: number, y: number, w: number, h: number) => ({ x, y, w, h }),
  };
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  const deps: SvgDeps = { image: () => img as unknown as HTMLImageElement, canvas: () => canvas as unknown as HTMLCanvasElement };
  return { log, img, canvas, deps };
}

describe('loadSvgCors', () => {
  test('sets crossOrigin before src, so a CORS-enabled server never taints the canvas', async () => {
    const f = fakeDeps();
    const p = loadSvgCors('http://127.0.0.1:8899/poster/m1.svg', 188, 282, null, null, null, null, f.deps);
    expect(f.log).toEqual(['crossOrigin=anonymous', 'src=http://127.0.0.1:8899/poster/m1.svg']);
    f.img.onload!();
    const r = await p;
    expect(f.log.at(-1)).toBe('draw 0,0,188x282');
    expect(r).toEqual({ data: { x: 0, y: 0, w: 188, h: 282 }, premultiplyAlpha: false });
    expect([f.canvas.width, f.canvas.height]).toEqual([188, 282]);
  });

  test('natural size when no size is given; the crop is read from the drawn canvas; data: URLs skip crossOrigin', async () => {
    const f = fakeDeps();
    const p = loadSvgCors('data:image/svg+xml,<svg/>', null, null, 5, 6, 10, 12, f.deps);
    expect(f.log).toEqual(['src=data:image/svg+xml,<svg/>']);
    f.img.onload!();
    expect(await p).toEqual({ data: { x: 5, y: 6, w: 10, h: 12 }, premultiplyAlpha: false });
    expect(f.log.at(-1)).toBe('draw 0,0,40x60');
  });

  test('a load error (no CORS, 404) rejects, so the renderer retries and the tile shows its fallback', async () => {
    const f = fakeDeps();
    const p = loadSvgCors('http://x.test/a.svg', 10, 10, null, null, null, null, f.deps);
    f.img.onerror!(new Error('blocked'));
    await expect(p).rejects.toThrow('blocked');
  });
});
