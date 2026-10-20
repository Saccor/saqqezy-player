/**
 * Transport icons for the VOD player: white glyphs on a transparent canvas, used as image textures (a node's `color`
 * tints them). Drawn once per kind and cached as data URLs, like `scrim.ts`: no icon font, no glyphs a TV font lacks.
 */
export type IconKind = 'play' | 'pause' | 'back10' | 'fwd10' | 'back30' | 'fwd30' | 'volume' | 'mute' | 'archive'
  | 'home' | 'tv' | 'film' | 'layers' | 'search' | 'gear' | 'chevron' | 'heart' | 'heartFilled' | 'close';

/** Line icons for the rail and headers: 24-unit SVG paths, stroked (Path2D is in every Chromium the TVs ship). */
const STROKES: Partial<Record<IconKind, { paths: string[]; fill?: boolean }>> = {
  home: { paths: ['M3 11 12 4l9 7', 'M5 10v10h14V10'] },
  tv: { paths: ['M5 6h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z', 'm8 2 4 4 4-4'] },
  film: { paths: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4'] },
  layers: { paths: ['m12 3 9 5-9 5-9-5 9-5Z', 'm3 13 9 5 9-5'] },
  search: { paths: ['M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z', 'm20 20-3.5-3.5'] },
  gear: { paths: ['M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z', 'M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1'] },
  chevron: { paths: ['m6 9 6 6 6-6'] },
  close: { paths: ['M6 6l12 12M18 6 6 18'] },
  heart: { paths: ['M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z'] },
  heartFilled: { paths: ['M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z'], fill: true },
};
export const STROKE_ICON_KINDS = Object.keys(STROKES) as IconKind[];

const SIZE = 96;
const cache = new Map<IconKind, string>();

function draw(ctx: CanvasRenderingContext2D, kind: IconKind): void {
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  const stroke = STROKES[kind];
  if (stroke) {
    ctx.save();
    ctx.scale(SIZE / 24, SIZE / 24);
    ctx.lineWidth = 1.8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const d of stroke.paths) {
      const p = new Path2D(d);
      if (stroke.fill) ctx.fill(p);
      ctx.stroke(p);
    }
    ctx.restore();
    return;
  }
  if (kind === 'play') {
    ctx.beginPath();
    ctx.moveTo(30, 18);
    ctx.lineTo(80, 48);
    ctx.lineTo(30, 78);
    ctx.closePath();
    ctx.fill();
    return;
  }
  if (kind === 'pause') {
    ctx.fillRect(24, 18, 16, 60);
    ctx.fillRect(56, 18, 16, 60);
    return;
  }
  if (kind === 'volume' || kind === 'mute') {
    // A speaker; with sound, two arcs; muted, a cross.
    ctx.beginPath();
    ctx.moveTo(14, 36);
    ctx.lineTo(32, 36);
    ctx.lineTo(54, 16);
    ctx.lineTo(54, 80);
    ctx.lineTo(32, 60);
    ctx.lineTo(14, 60);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    if (kind === 'mute') {
      ctx.beginPath();
      ctx.moveTo(64, 34);
      ctx.lineTo(86, 62);
      ctx.moveTo(86, 34);
      ctx.lineTo(64, 62);
      ctx.stroke();
      return;
    }
    for (const r of [14, 28]) {
      ctx.beginPath();
      ctx.arc(56, 48, r, -Math.PI / 3.2, Math.PI / 3.2, false);
      ctx.stroke();
    }
    return;
  }
  // A circular arrow (back: counter-clockwise, arrowhead at the top left; forward: mirrored) around "10" or "30".
  const fwd = kind === 'fwd10' || kind === 'fwd30';
  // 'archive' (catch-up marks in the Guide): the same circular arrow, thicker, with no number inside.
  const seconds = kind === 'archive' ? '' : kind.endsWith('30') ? '30' : '10';
  ctx.save();
  if (fwd) {
    ctx.translate(SIZE, 0);
    ctx.scale(-1, 1);
  }
  ctx.lineWidth = kind === 'archive' ? 12 : 7;
  ctx.lineCap = 'round';
  ctx.beginPath();
  // From the arrowhead at about 11 o'clock, clockwise round to about 9 o'clock (an open arc of ~300°).
  ctx.arc(48, 50, 36, -Math.PI * 0.62, Math.PI * 0.95, false);
  ctx.stroke();
  // The arrowhead at the arc's start, pointing back along it (counter-clockwise).
  const a = -Math.PI * 0.62;
  const hx = 48 + 36 * Math.cos(a);
  const hy = 50 + 36 * Math.sin(a);
  ctx.beginPath();
  ctx.moveTo(hx - 16, hy - 4);
  ctx.lineTo(hx + 6, hy - 14);
  ctx.lineTo(hx + 4, hy + 10);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  if (!seconds) return;
  ctx.font = 'bold 30px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(seconds, 48, 52);
}

/** The icon's texture URL; undefined without a DOM or 2D canvas. */
export function iconTexture(kind: IconKind): string | undefined {
  const hit = cache.get(kind);
  if (hit) return hit;
  if (typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  draw(ctx, kind);
  const url = canvas.toDataURL('image/png');
  cache.set(kind, url);
  return url;
}
