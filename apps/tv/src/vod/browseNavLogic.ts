import type { VodCategoryView } from '@iptv/app-api';
import { VOD_ALL } from '@iptv/core';
import { rowSlots, type RowFrame } from '../components/rowSlots.ts';
import { grouped } from './kindCopy.ts';

/**
 * Movies and Series browse: the Categories chips (a way into the full grid, one press from the top row) and how focus
 * moves between the tab bar, the hero, the chips and the poster rows. Pure: no Solid, no Lightning.
 */

export interface BrowseChip { id: string; label: string }
export type BrowseArea = 'tabs' | 'hero' | 'chips' | 'rows';
/** The line the page is scrolled to: the chips, or the poster rows (at the focused row). */
export type BrowseLine = 'chips' | 'rows';

/**
 * The grid rail's entries from its "All movies"/"All series" entry on, in the rail's order and names, with counts;
 * the entries before it (Continue watching, Favourites, Recently added) are rows on this screen already. Empty
 * categories are left out; no chips at all while there is no catalogue (no All entry, or an empty one).
 */
export function browseChips(cats: readonly VodCategoryView[]): BrowseChip[] {
  const at = cats.findIndex((c) => c.id === VOD_ALL);
  if (at < 0 || cats[at]!.count <= 0) return [];
  return cats.slice(at).filter((c) => c.count > 0).map((c) => ({ id: c.id, label: `${c.name} · ${grouped(c.count)}` }));
}

const CHIP_MIN_W = 160;
const CHIP_MAX_W = 520;
/** Body text (26 px) averages about 14 px a character; the label is centred with this much room each side. */
const CHIP_CHAR_W = 14;
const CHIP_PAD = 28;

/** A chip's width from its label (text is measured late in Lightning, so it is estimated; a long label is cut). */
export function chipWidth(label: string): number {
  return Math.max(CHIP_MIN_W, Math.min(CHIP_MAX_W, label.length * CHIP_CHAR_W + CHIP_PAD * 2));
}

export function chipLayout(labels: readonly string[], gap: number): { xs: number[]; ws: number[] } {
  const ws = labels.map(chipWidth);
  const xs: number[] = [];
  let x = 0;
  for (const w of ws) { xs.push(x); x += w + gap; }
  return { xs, ws };
}

/** The row's scroll (px) that keeps chip `focus` inside `viewW`, moving as little as possible from `prev`. */
export function chipScroll(xs: readonly number[], ws: readonly number[], focus: number, prev: number, viewW: number): number {
  const x = xs[focus];
  const w = ws[focus];
  if (x === undefined || w === undefined) return 0;
  if (x < prev) return x;
  if (x + w > prev + viewW) return x + w - viewW;
  return prev;
}

/** The remembered chip by id, else the index clamped. */
export function locateChip(chips: readonly BrowseChip[], id: string | undefined, index: number): number {
  if (chips.length === 0) return 0;
  const at = id === undefined ? -1 : chips.findIndex((c) => c.id === id);
  return at >= 0 ? at : Math.max(0, Math.min(index, chips.length - 1));
}

export function chipMove(count: number, i: number, key: 'up' | 'down' | 'left' | 'right'): { chip: number } | { edge: 'up' | 'down' } {
  if (key === 'up' || key === 'down') return { edge: key };
  const next = i + (key === 'left' ? -1 : 1);
  return { chip: Math.max(0, Math.min(count - 1, next)) };
}

/** The chips line only counts while there are chips. */
export const effectiveLine = (line: BrowseLine, hasChips: boolean): BrowseLine => (line === 'chips' && hasChips ? 'chips' : 'rows');

/**
 * Up out of an area (the rows only from their top row). The hero shows the rows' focused title, also while the chips
 * have focus, so it sits above the chips.
 */
export function areaAbove(from: 'rows' | 'chips' | 'hero', ctx: { chips: boolean; heroTile: boolean }): BrowseArea {
  if (from === 'rows' && ctx.chips) return 'chips';
  if (from !== 'hero' && ctx.heroTile) return 'hero';
  return 'tabs';
}

/** Down out of an area: the hero leads to the line the page is scrolled to. */
export function areaBelow(from: 'tabs' | 'hero' | 'chips', ctx: { chips: boolean; heroTile: boolean; rows: boolean; line: BrowseLine }): BrowseArea {
  if (from === 'tabs' && ctx.heroTile) return 'hero';
  if (from === 'chips') return ctx.rows ? 'rows' : 'chips';
  if (effectiveLine(ctx.line, ctx.chips) === 'chips') return 'chips';
  return ctx.rows ? 'rows' : ctx.chips ? 'chips' : 'hero';
}

/**
 * Where the chips and poster rows go: the line the page is scrolled to on top (the chips, or the focused row), then
 * the rows after it (`rowSlots`). `chipsY` is set only while the chips are on screen.
 */
export function browseSlots(
  s: { chipsH: number; rowH: number; chips: boolean; rowCount: number; line: BrowseLine; row: number },
  frame: RowFrame, mode: 'peek' | 'whole',
): { chipsY?: number; rows: { index: number; y: number }[] } {
  const offset = s.chips ? 1 : 0;
  const heights = [...(s.chips ? [s.chipsH] : []), ...Array.from({ length: s.rowCount }, () => s.rowH)];
  const focusLine = effectiveLine(s.line, s.chips) === 'chips' ? 0 : Math.max(0, Math.min(s.row, s.rowCount - 1)) + offset;
  const out: { chipsY?: number; rows: { index: number; y: number }[] } = { rows: [] };
  for (const slot of rowSlots(heights, focusLine, frame, mode)) {
    if (s.chips && slot.index === 0) out.chipsY = slot.y;
    else out.rows.push({ index: slot.index - offset, y: slot.y });
  }
  return out;
}

/** Green opens the grid on All only while the catalogue is ready: on loading, empty or failed it would show nothing. */
export const greenOpensGrid = (status: string | undefined): boolean => status === 'ready';
