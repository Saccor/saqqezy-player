import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs without types
import { BRAND, markSvg, renderPng, tileSvg } from '../mark.mjs';

interface Png { width: number; height: number; channels: number; px: (x: number, y: number) => number[] }

/** Decodes the generator's own PNGs: 8-bit RGB or RGBA, every row with filter 0. */
function decode(buf: Buffer): Png {
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  expect(buf[24]).toBe(8);
  const channels = buf[25] === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p);
    if (buf.toString('ascii', p + 4, p + 8) === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels + 1;
  expect(raw.length).toBe(stride * height);
  return {
    width, height, channels,
    px: (x, y) => [...raw.subarray(y * stride + 1 + x * channels, y * stride + 1 + (x + 1) * channels)],
  };
}

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

describe('brand mark', () => {
  it('draws the Tizen tile as an opaque 512x423 RGB PNG', () => {
    const png = decode(renderPng({ width: 512, height: 423, background: BRAND.tile }));
    expect([png.width, png.height, png.channels]).toEqual([512, 423, 3]);
    expect(png.px(0, 0)).toEqual(hex(BRAND.tile));
    expect(png.px(511, 422)).toEqual(hex(BRAND.tile));
    // The play triangle covers the centre; the ring passes straight above it.
    expect(png.px(256, 211)).toEqual(hex(BRAND.light));
    // Ring radius 104 in mark units around the centre; the mark spans 242 units = 62% of 423 px.
    const unit = (0.62 * 423) / 242;
    expect(png.px(256, Math.round(211.5 - 104 * unit))).toEqual(hex(BRAND.accent));
    expect(png.px(Math.round(256 + 104 * unit), 211)).toEqual(hex(BRAND.accent));
  });

  it('keeps clear space around the mark for the launcher mask', () => {
    const png = decode(renderPng({ width: 512, height: 423, background: BRAND.tile }));
    const edge = Math.floor(423 * 0.18);
    for (let x = 0; x < 512; x += 7) {
      expect(png.px(x, edge)).toEqual(hex(BRAND.tile));
      expect(png.px(x, 422 - edge)).toEqual(hex(BRAND.tile));
    }
  });

  it('draws a transparent RGBA logo layer when there is no background', () => {
    const png = decode(renderPng({ width: 192, height: 108 }));
    expect(png.channels).toBe(4);
    expect(png.px(0, 0)[3]).toBe(0);
    expect(png.px(96, 54)).toEqual([...hex(BRAND.light), 255]);
  });

  it('writes SVG masters with the brand colours', () => {
    const mark = markSvg();
    expect(mark).toMatch(/viewBox="0 0 512 512"/);
    expect(mark).toContain(BRAND.accent);
    expect(mark).toContain(BRAND.light);
    expect(mark).not.toContain(BRAND.tile);
    const tile = tileSvg();
    expect(tile).toMatch(/viewBox="0 0 512 423"/);
    expect(tile).toContain(BRAND.tile);
  });
});
