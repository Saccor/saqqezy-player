import { describe, expect, it } from 'vitest';
import { FOCUS } from '../shell/theme.ts';
import { POSTER_GAP, POSTER_H, POSTER_W } from '../vod/posterLogic.ts';
import { CHIP } from './countryGridLogic.ts';
import { EP_H, EP_ROW_H, EP_W, LOGO_TILE, tileFocus, tileGap, tileRowHeight, tileSize, type TileVariant } from './tileLogic.ts';
import { COMPACT_H, COMPACT_W, MATCH_GRID_H, WIDE_GAP, WIDE_H, WIDE_W } from './wideTileLogic.ts';

describe('tile variants (spec 2026-10-26 §1.3)', () => {
  it('sizes per variant, with overrides for posters and chips', () => {
    expect(tileSize('poster')).toEqual({ w: POSTER_W, h: POSTER_H });
    expect(tileSize('poster', { w: 150, h: 225 })).toEqual({ w: 150, h: 225 });
    expect(tileSize('wide')).toEqual({ w: WIDE_W, h: WIDE_H });
    expect(tileSize('wideCompact')).toEqual({ w: COMPACT_W, h: COMPACT_H });
    expect(tileSize('wideCompact', { detail: true })).toEqual({ w: COMPACT_W, h: MATCH_GRID_H });
    expect(tileSize('episode')).toEqual({ w: EP_W, h: EP_H });
    expect(tileSize('chip')).toEqual({ w: CHIP.w, h: CHIP.h });
    expect(tileSize('chip', { w: 600, h: 260 })).toEqual({ w: 600, h: 260 });
    expect(tileSize('logo')).toEqual({ w: LOGO_TILE, h: LOGO_TILE });
  });
  it('gaps and row heights', () => {
    expect(tileGap('poster')).toBe(POSTER_GAP);
    expect(tileGap('wide')).toBe(WIDE_GAP);
    expect(tileGap('episode')).toBe(24);
    expect(tileRowHeight('episode', EP_H)).toBe(EP_ROW_H);
    expect(tileRowHeight('poster', POSTER_H)).toBe(POSTER_H);
  });
  it('every tile scales 1.05 and gets the ring', () => {
    for (const v of ['poster', 'wide', 'wideCompact', 'episode', 'chip', 'logo'] as TileVariant[]) {
      expect(tileFocus(v)).toEqual({ scale: FOCUS.scale, ring: true });
    }
  });
});
