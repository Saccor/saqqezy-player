/**
 * Draw-size tags on image URLs. Renderer 3.7 decodes an image at its natural size (its loader never learns the node's
 * size), so a 1000×1500 poster drawn at 188×282 costs ~6 MB to upload and keep. A URL tagged with the size it is drawn
 * at goes through our loader instead (`shell/corsPlatform.ts` → `images/thumbLoader.ts`), which shrinks it once and
 * keeps the small copy on the device. The tag is a URL fragment: requests never send it, and the renderer's texture
 * cache keys on the whole string, so each drawn size is its own texture.
 */
const MARK = '#iptv-px=';

/** Device pixels per design pixel (1920×1080 design): 1 on TVs, the screen's ratio on desktop (`setImageScale`). */
let scale = 1;

/** Called at start and on resize with the renderer's design-to-buffer ratio (logical × physical). */
export function setImageScale(s: number): void {
  scale = Number.isFinite(s) && s > 0 ? s : 1;
}

/** `url` tagged with the box it is drawn in (design pixels, scaled to device pixels). Empty stays empty. */
export function sizedSrc(url: string, w: number, h: number): string {
  if (!url) return url;
  const pw = Math.max(1, Math.round(w * scale));
  const ph = Math.max(1, Math.round(h * scale));
  return `${url}${MARK}${pw}x${ph}`;
}

/** The URL and box of a tagged source; undefined for an untagged one (icons, data URIs, QR codes). */
export function parseSized(src: string): { url: string; w: number; h: number } | undefined {
  const at = src.lastIndexOf(MARK);
  if (at < 0) return undefined;
  const m = /^(\d+)x(\d+)$/.exec(src.slice(at + MARK.length));
  if (!m) return undefined;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!(w > 0 && h > 0)) return undefined;
  return { url: src.slice(0, at), w, h };
}

/**
 * The smallest size, at the image's own aspect, that still covers a `bw`×`bh` box: the box may stretch it (logos,
 * posters) or crop it (cover-fitted backdrops) exactly as before, with no visible loss. Never larger than the image.
 */
export function coverSize(iw: number, ih: number, bw: number, bh: number): { w: number; h: number } {
  if (!(iw > 0 && ih > 0)) return { w: iw, h: ih };
  const s = Math.min(1, Math.max(bw / iw, bh / ih));
  return { w: Math.max(1, Math.round(iw * s)), h: Math.max(1, Math.round(ih * s)) };
}

/** SVGs load through the renderer's own SVG path (rasterised at the node size already), never through ours. */
export function isSvgUrl(url: string): boolean {
  return /\.svg(\?[^#]*)?(#.*)?$/i.test(url);
}
