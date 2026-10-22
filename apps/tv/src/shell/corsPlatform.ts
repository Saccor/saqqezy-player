import { WebPlatform } from '@lightningjs/renderer/platforms';
import { browserThumbDeps } from '../images/browserThumbs.ts';
import { isSvgUrl, parseSized } from '../images/sizedSrc.ts';
import { loadThumb, type ThumbDeps } from '../images/thumbLoader.ts';
import { loadSvgCors } from './svgLoad.ts';

/**
 * The renderer's default web platform with two changes:
 * - SVG textures load with `crossOrigin = 'anonymous'` (`svgLoad.ts` says why).
 * - A source tagged with its drawn size (`images/sizedSrc.ts`) is shrunk to that size as it loads, and its small copy
 *   kept on the device (`images/thumbLoader.ts`). Untagged images (icons, QR codes) take the stock path.
 * Passed to `createRenderer` as `platform`. Everything else (the render loop, the image worker for untagged images) is
 * the stock `WebPlatform`.
 */
export class CorsWebPlatform extends WebPlatform {
  private thumbDeps: ThumbDeps | undefined;

  override loadSvg(src: string, width: number | null, height: number | null, sx?: number | null, sy?: number | null, sw?: number | null, sh?: number | null): ReturnType<WebPlatform['loadSvg']> {
    const url = new URL(src, self.location.href).href;
    return loadSvgCors(url, width, height, sx ?? null, sy ?? null, sw ?? null, sh ?? null);
  }

  override loadImage(src: string, premultiplyAlpha: boolean | null, sx?: number | null, sy?: number | null, sw?: number | null, sh?: number | null): ReturnType<WebPlatform['loadImage']> {
    const sized = parseSized(src);
    // A crop (sx/sy/sw/sh) keeps the stock path: the crop is in the source image's pixels.
    if (!sized || (sw != null && sh != null)) return super.loadImage(src, premultiplyAlpha, sx, sy, sw, sh);
    if (isSvgUrl(sized.url)) return this.loadSvg(sized.url, sized.w, sized.h);
    this.thumbDeps ??= browserThumbDeps((u) => this.fetch(new URL(u, self.location.href).href));
    return loadThumb(sized.url, sized.w, sized.h, premultiplyAlpha, this.thumbDeps) as unknown as ReturnType<WebPlatform['loadImage']>;
  }
}
