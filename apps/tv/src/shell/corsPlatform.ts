import { WebPlatform } from '@lightningjs/renderer/platforms';
import { loadSvgCors } from './svgLoad.ts';

/**
 * The renderer's default web platform with one change: SVG textures load with `crossOrigin = 'anonymous'`
 * (`svgLoad.ts` says why). Passed to `createRenderer` as `platform`. Everything else (raster images, the image
 * worker, the render loop) is the stock `WebPlatform`.
 */
export class CorsWebPlatform extends WebPlatform {
  override loadSvg(src: string, width: number | null, height: number | null, sx?: number | null, sy?: number | null, sw?: number | null, sh?: number | null): ReturnType<WebPlatform['loadSvg']> {
    const url = new URL(src, self.location.href).href;
    return loadSvgCors(url, width, height, sx ?? null, sy ?? null, sw ?? null, sh ?? null);
  }
}
