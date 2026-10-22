import { describe, expect, it } from 'vitest';
import { thumbMode } from './workerThumbDeps.ts';

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
