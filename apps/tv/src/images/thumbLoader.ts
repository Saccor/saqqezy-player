import { coverSize } from './sizedSrc.ts';
import type { ThumbRecord } from './thumbStore.ts';

/** What the renderer's `Platform.loadImage` returns (renderer 3.7 `TextureData`, the image case). */
export interface LoadedImage { data: ImageBitmap; premultiplyAlpha: boolean; premultiplied: true }

export interface ThumbDeps {
  fetchBlob(url: string): Promise<Blob>;
  store: { get(key: string): Promise<ThumbRecord | undefined>; put(key: string, type: string, bytes: ArrayBuffer): Promise<void> };
  /** `createImageBitmap` (injected for tests). */
  decode(src: Blob | ImageBitmap | HTMLCanvasElement, opts: ImageBitmapOptions): Promise<ImageBitmap>;
  /**
   * Copies `bitmap` at once (the renderer may close it after upload) and encodes it later, off the key path; resolves
   * with the encoded bytes, or undefined when encoding is not possible.
   */
  encodeLater(bitmap: ImageBitmap): Promise<{ type: string; bytes: ArrayBuffer } | undefined>;
  /** Draws `bitmap` into a `w`×`h` canvas: the fallback where `createImageBitmap` ignores `resizeWidth`. */
  drawScaled(bitmap: ImageBitmap, w: number, h: number): HTMLCanvasElement;
}

export const thumbKey = (url: string, w: number, h: number): string => `${w}x${h} ${url}`;

/**
 * Loads `url` for a `w`×`h` box (device pixels): a stored small copy when there is one; otherwise the image is fetched,
 * decoded, shrunk to the smallest size that still covers the box (`coverSize`), handed to the renderer, and its copy
 * stored for next time. Only shrunk images are stored (a small source image is cheap to fetch again).
 * `premultiplyAlpha` follows the renderer's own loader.
 */
export async function loadThumb(url: string, w: number, h: number, premultiplyAlpha: boolean | null | undefined, deps: ThumbDeps): Promise<LoadedImage> {
  const key = thumbKey(url, w, h);
  const stored = await deps.store.get(key);
  if (stored) {
    const blob = new Blob([stored.bytes], { type: stored.type });
    const alpha = premultiplyAlpha ?? stored.type.includes('png');
    return { data: await deps.decode(blob, bitmapOptions(alpha)), premultiplyAlpha: alpha, premultiplied: true };
  }
  const blob = await deps.fetchBlob(url);
  const alpha = premultiplyAlpha ?? blob.type.includes('image/png');
  const full = await deps.decode(blob, bitmapOptions(alpha));
  const t = coverSize(full.width, full.height, w, h);
  if (t.w >= full.width && t.h >= full.height) return { data: full, premultiplyAlpha: alpha, premultiplied: true };
  let small = await deps.decode(full, { resizeWidth: t.w, resizeHeight: t.h, resizeQuality: 'medium' });
  if (small.width !== t.w || small.height !== t.h) {
    // `resizeWidth` not honoured by this engine: scale through a canvas instead.
    small.close();
    small = await deps.decode(deps.drawScaled(full, t.w, t.h), {});
  }
  full.close();
  void deps.encodeLater(small).then((enc) => (enc ? deps.store.put(key, enc.type, enc.bytes) : undefined)).catch(() => undefined);
  return { data: small, premultiplyAlpha: alpha, premultiplied: true };
}

function bitmapOptions(alpha: boolean): ImageBitmapOptions {
  return { premultiplyAlpha: alpha ? 'premultiply' : 'none', colorSpaceConversion: 'none', imageOrientation: 'none' };
}
