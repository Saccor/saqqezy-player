import { coverSize } from './sizedSrc.ts';
import type { ThumbRecord } from './thumbStore.ts';

/** Where a loaded image came from: the device copy, the network shrunk, or the network as it was. */
export type ThumbFrom = 'stored' | 'fetched' | 'asIs';

/** What the renderer's `Platform.loadImage` returns (renderer 3.7 `TextureData`, the image case), plus its origin. */
export interface LoadedImage { data: ImageBitmap; premultiplyAlpha: boolean; premultiplied: true; from: ThumbFrom }

/** A canvas the scaled copy is drawn into: a DOM canvas in tests and old code, an `OffscreenCanvas` in the worker. */
export type ThumbCanvas = HTMLCanvasElement | OffscreenCanvas;

export interface ThumbDeps {
  fetchBlob(url: string): Promise<Blob>;
  store: { get(key: string): Promise<ThumbRecord | undefined>; put(key: string, type: string, bytes: ArrayBuffer): Promise<void> };
  /** `createImageBitmap` (injected for tests). */
  decode(src: Blob | ImageBitmap | ThumbCanvas, opts: ImageBitmapOptions): Promise<ImageBitmap>;
  /**
   * Copies `bitmap` at once (it is transferred or uploaded right after) and encodes it later, off the reply path;
   * resolves with the encoded bytes, or undefined when encoding is not possible or skipped.
   */
  encodeLater(bitmap: ImageBitmap): Promise<{ type: string; bytes: ArrayBuffer } | undefined>;
  /** Draws `bitmap` into a `w`×`h` canvas where `createImageBitmap` ignores `resizeWidth`; undefined: no canvas here. */
  drawScaled(bitmap: ImageBitmap, w: number, h: number): ThumbCanvas | undefined;
}

export const thumbKey = (url: string, w: number, h: number): string => `${w}x${h} ${url}`;

/**
 * Loads `url` for a `w`×`h` box (device pixels): a stored small copy when there is one; otherwise the image is fetched,
 * decoded, shrunk to the smallest size that still covers the box (`coverSize`), returned, and its copy stored for next
 * time. Only shrunk images are stored (a small source image is cheap to fetch again). Where neither a resize nor a
 * canvas works, the full image is returned as it is. `premultiplyAlpha` follows the renderer's own loader.
 */
export async function loadThumb(url: string, w: number, h: number, premultiplyAlpha: boolean | null | undefined, deps: ThumbDeps): Promise<LoadedImage> {
  const key = thumbKey(url, w, h);
  const stored = await deps.store.get(key);
  if (stored) {
    const blob = new Blob([stored.bytes], { type: stored.type });
    const alpha = premultiplyAlpha ?? stored.type.includes('png');
    return { data: await deps.decode(blob, bitmapOptions(alpha)), premultiplyAlpha: alpha, premultiplied: true, from: 'stored' };
  }
  const blob = await deps.fetchBlob(url);
  const alpha = premultiplyAlpha ?? blob.type.includes('image/png');
  const full = await deps.decode(blob, bitmapOptions(alpha));
  const t = coverSize(full.width, full.height, w, h);
  const asIs = (): LoadedImage => ({ data: full, premultiplyAlpha: alpha, premultiplied: true, from: 'asIs' });
  if (t.w >= full.width && t.h >= full.height) return asIs();
  let small = await deps.decode(full, { resizeWidth: t.w, resizeHeight: t.h, resizeQuality: 'medium' });
  if (small.width !== t.w || small.height !== t.h) {
    // `resizeWidth` not honoured by this engine: scale through a canvas instead, or keep the full image.
    small.close();
    const c = deps.drawScaled(full, t.w, t.h);
    if (!c) return asIs();
    small = await deps.decode(c, {});
  }
  full.close();
  void deps.encodeLater(small).then((enc) => (enc ? deps.store.put(key, enc.type, enc.bytes) : undefined)).catch(() => undefined);
  return { data: small, premultiplyAlpha: alpha, premultiplied: true, from: 'fetched' };
}

function bitmapOptions(alpha: boolean): ImageBitmapOptions {
  return { premultiplyAlpha: alpha ? 'premultiply' : 'none', colorSpaceConversion: 'none', imageOrientation: 'none' };
}
