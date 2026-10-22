import { describe, expect, it, vi } from 'vitest';
import { loadThumb, thumbKey, type ThumbDeps } from './thumbLoader.ts';
import type { ThumbRecord } from './thumbStore.ts';

/** A stand-in ImageBitmap: its size, what it came from, and whether it was closed. */
interface FakeBitmap { width: number; height: number; from: string; closed: boolean; close(): void }
const bitmap = (width: number, height: number, from: string): FakeBitmap =>
  ({ width, height, from, closed: false, close() { this.closed = true; } });

function setup(opts: { natural?: [number, number]; honoursResize?: boolean; stored?: ThumbRecord } = {}) {
  const [nw, nh] = opts.natural ?? [1000, 1500];
  const puts: Array<[string, string, number]> = [];
  const store = new Map<string, ThumbRecord>();
  if (opts.stored) store.set(thumbKey('http://img.test/p.jpg', 188, 282), opts.stored);
  const deps: ThumbDeps = {
    fetchBlob: vi.fn(async () => new Blob([new Uint8Array(4)], { type: 'image/jpeg' })),
    store: {
      get: async (k) => store.get(k),
      put: async (k, type, bytes) => { puts.push([k, type, bytes.byteLength]); },
    },
    decode: vi.fn(async (src: Blob | ImageBitmap | HTMLCanvasElement, o: ImageBitmapOptions) => {
      if (src instanceof Blob) return (src.size === 4 ? bitmap(nw, nh, 'network') : bitmap(188, 282, 'stored')) as unknown as ImageBitmap;
      if ((src as unknown as { canvas?: boolean }).canvas) return bitmap(src.width, src.height, 'canvas') as unknown as ImageBitmap;
      const w = opts.honoursResize === false ? src.width : (o.resizeWidth ?? src.width);
      const h = opts.honoursResize === false ? src.height : (o.resizeHeight ?? src.height);
      return bitmap(w, h, 'resized') as unknown as ImageBitmap;
    }),
    encodeLater: vi.fn(async () => ({ type: 'image/webp', bytes: new ArrayBuffer(9) })),
    drawScaled: vi.fn((_b: ImageBitmap, w: number, h: number) => ({ canvas: true, width: w, height: h }) as unknown as HTMLCanvasElement),
  };
  return { deps, puts };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('loadThumb', () => {
  it('shrinks a large image to cover its box, frees the full decode and stores the copy', async () => {
    const { deps, puts } = setup();
    const r = await loadThumb('http://img.test/p.jpg', 188, 282, true, deps);
    const b = r.data as unknown as FakeBitmap;
    expect([b.width, b.height, b.from]).toEqual([188, 282, 'resized']);
    expect(r.premultiplyAlpha).toBe(true);
    const full = await (deps.decode as ReturnType<typeof vi.fn>).mock.results[0]!.value as FakeBitmap;
    expect(full.closed).toBe(true);
    await flush();
    expect(puts).toEqual([['188x282 http://img.test/p.jpg', 'image/webp', 9]]);
  });

  it('a stored copy skips the network', async () => {
    const { deps } = setup({ stored: { type: 'image/webp', bytes: new ArrayBuffer(9) } });
    const r = await loadThumb('http://img.test/p.jpg', 188, 282, true, deps);
    expect((r.data as unknown as FakeBitmap).from).toBe('stored');
    expect(deps.fetchBlob).not.toHaveBeenCalled();
  });

  it('a small image is drawn as it is and not stored', async () => {
    const { deps, puts } = setup({ natural: [120, 120] });
    const r = await loadThumb('http://img.test/p.jpg', 188, 282, true, deps);
    expect((r.data as unknown as FakeBitmap).from).toBe('network');
    await flush();
    expect(puts).toEqual([]);
    expect(deps.encodeLater).not.toHaveBeenCalled();
  });

  it('falls back to a canvas where createImageBitmap ignores the resize', async () => {
    const { deps } = setup({ honoursResize: false });
    const r = await loadThumb('http://img.test/p.jpg', 188, 282, true, deps);
    const b = r.data as unknown as FakeBitmap;
    expect([b.width, b.height, b.from]).toEqual([188, 282, 'canvas']);
    expect(deps.drawScaled).toHaveBeenCalledOnce();
  });

  it('a failed fetch fails the load (the renderer marks the texture failed)', async () => {
    const { deps } = setup();
    deps.fetchBlob = async () => { throw new Error('404'); };
    await expect(loadThumb('http://img.test/p.jpg', 188, 282, true, deps)).rejects.toThrow('404');
  });

  it('a failed encode or store never fails the load', async () => {
    const { deps } = setup();
    deps.encodeLater = async () => { throw new Error('no canvas'); };
    const r = await loadThumb('http://img.test/p.jpg', 188, 282, true, deps);
    expect((r.data as unknown as FakeBitmap).width).toBe(188);
    await flush();
  });
});
