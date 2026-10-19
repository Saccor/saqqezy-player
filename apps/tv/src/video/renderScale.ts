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
