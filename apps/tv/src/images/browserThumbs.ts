import { idleSchedule } from '../vod/preload.ts';
import type { ThumbDeps } from './thumbLoader.ts';
import { ThumbStore } from './thumbStore.ts';

/** Copies waiting to be encoded; past this, new ones are not kept (they load again from the network next time). */
const MAX_PENDING = 24;
const QUALITY = 0.82;

let pending = 0;
/** Encoded type that works here: WebP (small, keeps alpha) where the canvas can write it, else PNG. */
let encodeType: 'image/webp' | 'image/png' | undefined;

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toBlob(c: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => c.toBlob(resolve, type, QUALITY));
}

async function encode(c: HTMLCanvasElement): Promise<{ type: string; bytes: ArrayBuffer } | undefined> {
  let blob = await toBlob(c, encodeType ?? 'image/webp');
  if (blob && encodeType === undefined) encodeType = blob.type === 'image/webp' ? 'image/webp' : 'image/png';
  if (blob && blob.type !== encodeType) blob = await toBlob(c, encodeType ?? 'image/png');
  if (!blob) return undefined;
  return { type: blob.type, bytes: await blob.arrayBuffer() };
}

/** The real `loadThumb` dependencies: `createImageBitmap`, canvases, an idle-time encoder and the device store. */
export function browserThumbDeps(fetchBlob: (url: string) => Promise<Blob>): ThumbDeps {
  return {
    fetchBlob,
    store: new ThumbStore(),
    decode: (src, opts) => createImageBitmap(src, opts),
    drawScaled(bitmap, w, h) {
      const c = canvas(w, h);
      c.getContext('2d')?.drawImage(bitmap, 0, 0, w, h);
      return c;
    },
    encodeLater(bitmap) {
      if (pending >= MAX_PENDING) return Promise.resolve(undefined);
      // Copied now: the renderer may close the bitmap once it is uploaded. A small copy (~0.2 MB) per pending image.
      const c = canvas(bitmap.width, bitmap.height);
      const ctx = c.getContext('2d');
      if (!ctx) return Promise.resolve(undefined);
      ctx.drawImage(bitmap, 0, 0);
      pending += 1;
      return new Promise((resolve) => {
        idleSchedule(() => {
          encode(c).then(resolve, () => resolve(undefined)).finally(() => { pending -= 1; });
        });
      });
    },
  };
}
