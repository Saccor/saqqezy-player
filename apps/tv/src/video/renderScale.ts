import { designScale } from './videoLayer.ts';
import { isTvPlatform } from './engineConfig.ts';

/** The renderer's two ratios: canvas CSS size = 1920×1080 × logical, buffer = CSS size × physical. */
export interface RenderPixelRatios {
  logical: number;
  physical: number;
}

/**
 * Pixel ratios for the Lightning renderer. The canvas always covers the viewport in CSS pixels (`logical` is the
 * design scale). On a TV the drawing buffer is capped at the 1920×1080 design size and the compositor upscales it:
 * a TV whose graphics plane is 2560×1440 (likely the Odyssey G9) or 4K would otherwise fill 1.8× or 4× the pixels on
 * every frame, and rasterise every text texture that much larger, on a GPU sized for 1080p. A smaller viewport is
 * never supersampled. Desktop and browser keep the full device pixel ratio for sharp text on monitors.
 */
export function renderPixelRatios(
  platform: string,
  win: { innerWidth: number; innerHeight: number; devicePixelRatio: number } = window,
): RenderPixelRatios {
  const logical = designScale(win);
  const dpr = win.devicePixelRatio > 0 ? win.devicePixelRatio : 1;
  const physical = isTvPlatform(platform) ? Math.min(dpr, 1 / logical) : dpr;
  return { logical, physical };
}

/** Renderer settings that differ on a TV. */
export interface RendererTuning {
  /** Off-screen nodes this close to the screen (px) load their textures before they scroll in. */
  boundsMargin: number;
  /** Most time (ms) per frame spent uploading textures; the rest wait for the next frame. */
  textureProcessingTimeLimit: number;
  /** Texture uploads per frame while any animation runs (renderer default 1; text textures share the queue). */
  maxTextureUploadsDuringAnimation: number;
  /** Render loop cap (renderer default 0: the display's refresh rate, up to 240 Hz on some panels). */
  targetFPS: number;
}

/**
 * TVs:
 * - Renderer 3.7 falls back to 42 ms of texture work per frame (its docs say 10). On a TV CPU and GPU that shows as a
 *   hitch right after a key press that brings in new posters; 10 ms spreads the uploads over frames instead.
 * - A 200 px margin starts loading the next tiles (the row buffer) before they scroll in.
 * - While any animation runs, the renderer uploads only 1 texture per frame by default, so a new poster row (14
 *   posters plus its texts) drained over 20+ frames; 4 lets the 10 ms limit govern instead.
 * - 60 fps: a panel that vsyncs above 60 would otherwise rebuild and upload up to 4x as many frames per animation.
 *
 * Desktop and browser keep the renderer's defaults.
 */
export function rendererTuning(platform: string): Partial<RendererTuning> {
  return isTvPlatform(platform)
    ? { boundsMargin: 200, textureProcessingTimeLimit: 10, maxTextureUploadsDuringAnimation: 4, targetFPS: 60 }
    : {};
}
