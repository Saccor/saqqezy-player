/** Tile (spec 2026-10-26 §1.3): variants, sizes, gaps, focus. Pure: no Solid, no Lightning. */
import { FOCUS, SPACE } from '../shell/theme.ts';
import { POSTER_GAP, POSTER_H, POSTER_W } from '../vod/posterLogic.ts';
import { CHIP } from './countryGridLogic.ts';
import { COMPACT_H, COMPACT_W, MATCH_GRID_H, WIDE_GAP, WIDE_H, WIDE_W } from './wideTileLogic.ts';

export type TileVariant = 'poster' | 'wide' | 'wideCompact' | 'episode' | 'chip' | 'logo';

export const EP_W = 400;
export const EP_H = 225;
const EP_GAP = SPACE.l;
/** Episode cards fully in view; the next one peeks in at the right edge. */
export const EP_VISIBLE = 4;
/** The still plus the meta, title and two synopsis lines below it. */
export const EP_ROW_H = EP_H + 150;
/** Skeleton cards while a series loads. */
export const EP_SKELETON = 5;
export const LOGO_TILE = 96;

export function tileSize(variant: TileVariant, o: { w?: number; h?: number; detail?: boolean } = {}): { w: number; h: number } {
  switch (variant) {
    case 'poster': return { w: o.w ?? POSTER_W, h: o.h ?? POSTER_H };
    case 'wide': return { w: WIDE_W, h: WIDE_H };
    case 'wideCompact': return { w: COMPACT_W, h: o.detail ? MATCH_GRID_H : COMPACT_H };
    case 'episode': return { w: EP_W, h: EP_H };
    case 'chip': return { w: o.w ?? CHIP.w, h: o.h ?? CHIP.h };
    case 'logo': return { w: o.w ?? LOGO_TILE, h: o.h ?? LOGO_TILE };
  }
}

export function tileGap(variant: TileVariant): number {
  if (variant === 'poster') return POSTER_GAP;
  if (variant === 'wide' || variant === 'wideCompact') return WIDE_GAP;
  if (variant === 'chip') return CHIP.gap;
  return EP_GAP;
}

/** The height a row of this variant needs: episode cards carry three text lines under the still. */
export const tileRowHeight = (variant: TileVariant, h: number): number => (variant === 'episode' ? EP_ROW_H : h);

/** Tiles and posters: scale 1.05 plus a 4 px ring at 4 px offset (spec §1.2). */
export const tileFocus = (_variant: TileVariant): { scale: number; ring: boolean } => ({ scale: FOCUS.scale, ring: true });
