// The Saqqezy Player mark: a Q ring with a play triangle inside (spec: docs/superpowers/specs/2026-10-22-name-and-mark-design.md).
// One geometry for the SVG masters and the PNG exports. Plain Node + zlib, no packages.
import { deflateSync } from 'node:zlib';

export const BRAND = {
  /** Opaque tile behind the mark. */
  tile: '#121a30',
  /** The ring and its tail. */
  accent: '#6d72ff',
  /** The play triangle. */
  light: '#eef0f4',
};

/**
 * Geometry in mark units, centred on the ring. The ring sets the bounding box (±121, so 242 units); the tail's
 * cap stays inside it on both axes.
 *
 * The tail starts inside the ring's hole and crosses the stroke, like the tail of a typeset Q, and only pokes a
 * little way out; a tail that starts on the outside of the ring would read as a magnifier (search) instead.
 */
const EXTENT = 242;
const RING = { cx: 0, cy: 0, r: 104, w: 34 };
const TAIL = { x1: 49.5, y1: 49.5, x2: 97.6, y2: 97.6, w: 34 };
/** Play triangle corners (optically centred in the ring); every point within `TRI_ROUND` is inked, rounding them. */
const TRI = [[-24, -50], [-24, 50], [56, 0]];
const TRI_ROUND = 7;
/** Default mark size as a share of the tile's shorter side: clear of Samsung's squircle mask. */
export const MARK_SCALE = 0.62;

// --- SVG ---------------------------------------------------------------------------------------------------------

function markElements(scale, ox, oy) {
  const p = (x, y) => `${+(ox + x * scale).toFixed(2)} ${+(oy + y * scale).toFixed(2)}`;
  const n = (v) => +(v * scale).toFixed(2);
  const [a, b, c] = TRI;
  return [
    `<circle cx="${+(ox + RING.cx * scale).toFixed(2)}" cy="${+(oy + RING.cy * scale).toFixed(2)}" r="${n(RING.r)}" fill="none" stroke="${BRAND.accent}" stroke-width="${n(RING.w)}"/>`,
    `<path d="M${p(TAIL.x1, TAIL.y1)} L${p(TAIL.x2, TAIL.y2)}" stroke="${BRAND.accent}" stroke-width="${n(TAIL.w)}" stroke-linecap="round"/>`,
    `<path d="M${p(...a)} L${p(...b)} L${p(...c)} Z" fill="${BRAND.light}" stroke="${BRAND.light}" stroke-width="${n(TRI_ROUND * 2)}" stroke-linejoin="round"/>`,
  ];
}

function svg(width, height, body) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    '  <title>Saqqezy Player</title>',
    ...body.map((l) => `  ${l}`),
    '</svg>',
    '',
  ].join('\n');
}

/** The mark alone on a transparent square (master). `fill` is the share of the square the mark spans. */
export function markSvg({ size = 512, fill = 0.9 } = {}) {
  return svg(size, size, markElements((size * fill) / EXTENT, size / 2, size / 2));
}

/** The opaque launcher tile (master), Samsung's 512x423 by default. */
export function tileSvg({ width = 512, height = 423, markScale = MARK_SCALE } = {}) {
  const scale = (Math.min(width, height) * markScale) / EXTENT;
  return svg(width, height, [
    `<rect width="${width}" height="${height}" fill="${BRAND.tile}"/>`,
    ...markElements(scale, width / 2, height / 2),
  ]);
}

// --- PNG ---------------------------------------------------------------------------------------------------------

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const ACCENT = rgb(BRAND.accent);
const LIGHT = rgb(BRAND.light);

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function inTriangle(x, y) {
  const [[ax, ay], [bx, by], [cx, cy]] = TRI;
  const s = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = s(x, y, ax, ay, bx, by);
  const d2 = s(x, y, bx, by, cx, cy);
  const d3 = s(x, y, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** The ink at a point in mark units: the triangle is on top, then the ring and tail, else nothing. */
function inkAt(x, y) {
  const [[ax, ay], [bx, by], [cx, cy]] = TRI;
  if (inTriangle(x, y)
    || Math.min(segDist(x, y, ax, ay, bx, by), segDist(x, y, bx, by, cx, cy), segDist(x, y, cx, cy, ax, ay)) <= TRI_ROUND) {
    return LIGHT;
  }
  if (Math.abs(Math.hypot(x - RING.cx, y - RING.cy) - RING.r) <= RING.w / 2) return ACCENT;
  if (segDist(x, y, TAIL.x1, TAIL.y1, TAIL.x2, TAIL.y2) <= TAIL.w / 2) return ACCENT;
  return null;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * Draws the mark centred on a `width` x `height` PNG. With `background` (a `#rrggbb`) it is an opaque 24-bit RGB
 * tile; without, a 32-bit RGBA layer on transparency. `markScale` is the mark's size as a share of the shorter
 * side (0 draws only the background). Edges are anti-aliased with 4x4 supersampling.
 */
export function renderPng({ width, height, background, markScale = MARK_SCALE }) {
  const SS = 4;
  const channels = background ? 3 : 4;
  const bg = background ? rgb(background) : [0, 0, 0];
  const scale = (Math.min(width, height) * markScale) / EXTENT;
  const half = (EXTENT / 2) * scale + 2;
  const stride = width * channels + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      let r = 0; let g = 0; let b = 0; let inked = 0;
      const near = scale > 0 && Math.abs(x + 0.5 - width / 2) <= half && Math.abs(y + 0.5 - height / 2) <= half;
      for (let sy = 0; near && sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = inkAt((x + (sx + 0.5) / SS - width / 2) / scale, (y + (sy + 0.5) / SS - height / 2) / scale);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; inked++;
        }
      }
      const n = SS * SS;
      const o = y * stride + 1 + x * channels;
      if (background) {
        const rest = n - inked;
        raw[o] = Math.round((r + bg[0] * rest) / n);
        raw[o + 1] = Math.round((g + bg[1] * rest) / n);
        raw[o + 2] = Math.round((b + bg[2] * rest) / n);
      } else if (inked) {
        // Straight (not premultiplied) alpha: the average colour of the inked samples, alpha = their share.
        raw[o] = Math.round(r / inked);
        raw[o + 1] = Math.round(g / inked);
        raw[o + 2] = Math.round(b / inked);
        raw[o + 3] = Math.round((inked / n) * 255);
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = background ? 2 : 6; // colour type: RGB or RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
