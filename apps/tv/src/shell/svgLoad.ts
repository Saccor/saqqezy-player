/**
 * SVG textures for the Lightning renderer, loaded with CORS.
 *
 * `@lightningjs/renderer` 3.7 draws an SVG through an `<img>` onto a 2D canvas and reads it back with
 * `getImageData`, but never sets `img.crossOrigin`. A cross-origin SVG therefore taints the canvas even when its
 * server sends `Access-Control-Allow-Origin` (the fake provider's posters did), and `getImageData` throws a
 * `SecurityError`: the tile stays a plain block. With `crossOrigin = 'anonymous'` a CORS-enabled server works; one
 * without CORS fails to load (`onerror`), which is no worse than the SecurityError it gave before, and the renderer's
 * retry and the tile's fallback take over. Raster images are unaffected: the renderer fetches them with XHR and
 * decodes with `createImageBitmap`, which needs CORS anyway (or the dev proxy in `vite dev`).
 */
export interface SvgDeps {
  image: () => HTMLImageElement;
  canvas: () => HTMLCanvasElement;
}

const domDeps: SvgDeps = { image: () => new Image(), canvas: () => document.createElement('canvas') };

/** `'anonymous'` for every URL that goes over the network; `data:` and `blob:` URLs never need CORS. */
export function svgCrossOrigin(url: string): 'anonymous' | undefined {
  return /^(data|blob):/i.test(url) ? undefined : 'anonymous';
}

/** The renderer's `loadSvg`, with CORS: same arguments and result (`{ data: ImageData, premultiplyAlpha: false }`). */
export function loadSvgCors(
  url: string, width: number | null, height: number | null,
  sx: number | null, sy: number | null, sw: number | null, sh: number | null, deps: SvgDeps = domDeps,
): Promise<{ data: ImageData; premultiplyAlpha: boolean }> {
  return new Promise((resolve, reject) => {
    const canvas = deps.canvas();
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('No 2D canvas for SVG textures'));
      return;
    }
    ctx.imageSmoothingEnabled = true;
    const img = deps.image();
    img.onload = () => {
      try {
        const w = width || img.width;
        const h = height || img.height;
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(img, 0, 0, w, h);
        resolve({ data: ctx.getImageData(sx ?? 0, sy ?? 0, sw ?? w, sh ?? h), premultiplyAlpha: false });
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = (err) => reject(err);
    // Before `src`: the request mode is fixed when loading starts.
    const cors = svgCrossOrigin(url);
    if (cors) img.crossOrigin = cors;
    img.src = url;
  });
}
