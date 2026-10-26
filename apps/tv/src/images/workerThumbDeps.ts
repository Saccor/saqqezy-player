import type { ThumbCanvas, ThumbDeps } from './thumbLoader.ts';

/** What this worker can do with images (decided once at start). */
export type ThumbMode = 'full' | 'shrink' | 'stock';

export interface WorkerGlobals { createImageBitmap?: unknown; fetch?: unknown; OffscreenCanvas?: unknown }

/**
 * `full`: decode, shrink and keep WebP/PNG copies. `shrink`: decode and shrink, keep no copies (no `convertToBlob`).
 * `stock`: images take the renderer's own loader (full size, decoded in its image worker), never the UI thread.
 */
export function thumbMode(g: WorkerGlobals): ThumbMode {
  if (typeof g.createImageBitmap !== 'function' || typeof g.fetch !== 'function') return 'stock';
  const oc: unknown = g.OffscreenCanvas;
  return typeof oc === 'function' && typeof (oc as { prototype?: { convertToBlob?: unknown } }).prototype?.convertToBlob === 'function' ? 'full' : 'shrink';
}

export interface EncodeCounters { kept(): void; skipped(): void }

const QUALITY = 0.82;
/** Copies waiting to be encoded; past this, new ones are not kept (they load again from the network next time). */
const MAX_PENDING = 24;

/** The real `loadThumb` dependencies inside the thumbnail worker. */
export function workerThumbDeps(opts: { mode: ThumbMode; store: ThumbDeps['store']; counters: EncodeCounters; maxPending?: number }): ThumbDeps {
  const maxPending = opts.maxPending ?? MAX_PENDING;
  let pending = 0;
  /** Encoded type that works here: WebP (small, keeps alpha) where the canvas can write it, else PNG. */
  let encodeType: 'image/webp' | 'image/png' | undefined;
  const hasCanvas = typeof (globalThis as WorkerGlobals).OffscreenCanvas === 'function';

  async function encode(c: OffscreenCanvas): Promise<{ type: string; bytes: ArrayBuffer } | undefined> {
    let blob = await c.convertToBlob({ type: encodeType ?? 'image/webp', quality: QUALITY });
    if (encodeType === undefined) encodeType = blob.type === 'image/webp' ? 'image/webp' : 'image/png';
    if (blob.type !== encodeType) blob = await c.convertToBlob({ type: encodeType, quality: QUALITY });
    return { type: blob.type, bytes: await blob.arrayBuffer() };
  }

  return {
    async fetchBlob(url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.blob();
    },
    store: opts.store,
    decode: (src, o) => createImageBitmap(src as ImageBitmapSource, o),
    drawScaled(bitmap, w, h): ThumbCanvas | undefined {
      if (!hasCanvas) return undefined;
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d');
      if (!ctx) return undefined;
      ctx.drawImage(bitmap, 0, 0, w, h);
      return c;
    },
    encodeLater(bitmap) {
      if (opts.mode !== 'full' || pending >= maxPending) {
        opts.counters.skipped();
        return Promise.resolve(undefined);
      }
      // Copied now: the bitmap is transferred to the UI thread right after this call returns.
      let c: OffscreenCanvas;
      try {
        c = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = c.getContext('2d');
        if (!ctx) {
          opts.counters.skipped();
          return Promise.resolve(undefined);
        }
        ctx.drawImage(bitmap, 0, 0);
      } catch {
        // Allocation can fail on a low-memory TV; the image itself still loads, only its kept copy is dropped.
        opts.counters.skipped();
        return Promise.resolve(undefined);
      }
      pending += 1;
      // A macrotask later, so the reply with the bitmap is posted before the encode starts.
      return new Promise<void>((r) => setTimeout(r, 0))
        .then(() => encode(c))
        .then((enc) => { if (enc) opts.counters.kept(); else opts.counters.skipped(); return enc; },
          () => { opts.counters.skipped(); return undefined; })
        .finally(() => { pending -= 1; });
    },
  };
}
