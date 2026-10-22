import { WebPlatform } from '@lightningjs/renderer/platforms';
import { isSvgUrl, parseSized } from '../images/sizedSrc.ts';
import { startThumbClient, type PortLike } from '../images/thumbClient.ts';
// `?worker`: a module worker in dev, a classic worker in the build (`worker.format: 'iife'`, Chromium 76 TVs).
import ThumbWorker from '../images/thumbWorker.ts?worker';
import { loadSvgCors } from './svgLoad.ts';

/** The one thumbnail worker, started by the first sized image. */
let thumbPort: PortLike | undefined;

/**
 * The renderer's default web platform with two changes:
 * - SVG textures load with `crossOrigin = 'anonymous'` (`svgLoad.ts` says why).
 * - A source tagged with its drawn size (`images/sizedSrc.ts`) is loaded by the thumbnail worker
 *   (`images/thumbWorker.ts`): fetched, shrunk to that size and kept as a small copy on the device, all off the UI
 *   thread; only the finished bitmap comes back. Untagged images (icons, QR codes) take the stock path.
 * Passed to `createRenderer` as `platform`. Everything else (the render loop, the image worker for untagged images) is
 * the stock `WebPlatform`.
 */
export class CorsWebPlatform extends WebPlatform {
  override loadSvg(src: string, width: number | null, height: number | null, sx?: number | null, sy?: number | null, sw?: number | null, sh?: number | null): ReturnType<WebPlatform['loadSvg']> {
    const url = new URL(src, self.location.href).href;
    return loadSvgCors(url, width, height, sx ?? null, sy ?? null, sw ?? null, sh ?? null);
  }

  override loadImage(src: string, premultiplyAlpha: boolean | null, sx?: number | null, sy?: number | null, sw?: number | null, sh?: number | null): ReturnType<WebPlatform['loadImage']> {
    const sized = parseSized(src);
    // A crop (sx/sy/sw/sh) keeps the stock path: the crop is in the source image's pixels.
    if (!sized || (sw != null && sh != null)) return super.loadImage(src, premultiplyAlpha, sx, sy, sw, sh);
    if (isSvgUrl(sized.url)) return this.loadSvg(sized.url, sized.w, sized.h);
    thumbPort ??= new ThumbWorker() as unknown as PortLike;
    const client = startThumbClient(thumbPort);
    const url = new URL(sized.url, self.location.href).href;
    const stock = () => super.loadImage(sized.url, premultiplyAlpha) as unknown as ReturnType<typeof client.load>;
    return client.load(url, sized.w, sized.h, premultiplyAlpha, stock) as unknown as ReturnType<WebPlatform['loadImage']>;
  }
}
