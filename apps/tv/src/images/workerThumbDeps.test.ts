import { afterEach, describe, expect, it } from 'vitest';
import { thumbMode, workerThumbDeps } from './workerThumbDeps.ts';

class FullCanvas { convertToBlob() { return Promise.resolve(new Blob()); } }
class PlainCanvas {}
const fn = () => undefined;

describe('thumbMode', () => {
  it('full when the worker can decode, fetch and encode', () => {
    expect(thumbMode({ createImageBitmap: fn, fetch: fn, OffscreenCanvas: FullCanvas })).toBe('full');
  });
  it('shrink without OffscreenCanvas or without convertToBlob', () => {
    expect(thumbMode({ createImageBitmap: fn, fetch: fn })).toBe('shrink');
    expect(thumbMode({ createImageBitmap: fn, fetch: fn, OffscreenCanvas: PlainCanvas })).toBe('shrink');
  });
  it('stock without createImageBitmap or fetch in the worker', () => {
    expect(thumbMode({ fetch: fn, OffscreenCanvas: FullCanvas })).toBe('stock');
    expect(thumbMode({ createImageBitmap: fn })).toBe('stock');
  });
});

describe('workerThumbDeps encodeLater', () => {
  const original = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
  afterEach(() => { (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = original; });

  it('a throw while copying the bitmap resolves undefined and counts a skip', async () => {
    class ThrowingCanvas { constructor() { throw new Error('allocation failed'); } }
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = ThrowingCanvas;
    let skipped = 0;
    const deps = workerThumbDeps({ mode: 'full', store: {} as never, counters: { kept() {}, skipped() { skipped += 1; } } });
    const bitmap = { width: 4, height: 4 } as unknown as ImageBitmap;
    let result: Promise<unknown> | undefined;
    expect(() => { result = deps.encodeLater(bitmap); }).not.toThrow();
    await expect(result).resolves.toBeUndefined();
    expect(skipped).toBe(1);
  });
});
