/** The left rail (UI revamp spec §1.3). Pure: no Solid, no Lightning. */
import { LIVE_COPY } from '../copy.ts';
import type { IconKind } from '../vod/icons.ts';
import { tabNavigation, tabOfKind, type TabId, type TabNav, type VodKind } from '../vod/tabLogic.ts';
import { LAYOUT } from './theme.ts';

export type RailId = TabId | 'search' | 'settings';

export const RAIL_ITEMS: readonly RailId[] = ['start', 'live', 'movies', 'series', 'search', 'settings'];
export const RAIL_LABELS: Record<RailId, string> = LIVE_COPY.rail;
/** Expanded width (an overlay: content never reflows). */
export const RAIL_OPEN_W = 320;
export const RAIL_ICON = 34;
/** One row's hit and focus-pill height, centred on its icon. */
export const RAIL_ROW_H = 64;
const TOP = 260;
const PITCH = 78;
/** Settings sits apart, at the bottom: 70 px above the safe edge. */
const SETTINGS_Y = LAYOUT.height - LAYOUT.safeY - 70 - RAIL_ICON;

const ICONS: Record<RailId, IconKind> = { start: 'home', live: 'tv', movies: 'film', series: 'layers', search: 'search', settings: 'gear' };

/** The open rail's close button (pointer mode): a square in the panel's top-right corner. */
export const RAIL_CLOSE = { x: RAIL_OPEN_W - 24 - 48, y: LAYOUT.safeY, size: 48 } as const;

/** True when a rail-local point is on the close button. */
export function onRailClose(x: number, y: number): boolean {
  return x >= RAIL_CLOSE.x && x < RAIL_CLOSE.x + RAIL_CLOSE.size && y >= RAIL_CLOSE.y && y < RAIL_CLOSE.y + RAIL_CLOSE.size;
}

export function railY(id: RailId): number {
  return id === 'settings' ? SETTINGS_Y : TOP + RAIL_ITEMS.indexOf(id) * PITCH;
}

export function railItemAt(y: number): RailId | undefined {
  const pad = (RAIL_ROW_H - RAIL_ICON) / 2;
  return RAIL_ITEMS.find((id) => y >= railY(id) - pad && y < railY(id) - pad + RAIL_ROW_H);
}

export function stepRail(id: RailId, d: 1 | -1): RailId {
  const i = Math.max(0, Math.min(RAIL_ITEMS.length - 1, RAIL_ITEMS.indexOf(id) + d));
  return RAIL_ITEMS[i]!;
}

export const railIcon = (id: RailId): IconKind => ICONS[id];

export type RailNav = TabNav | { action: 'pushScreen'; screen: 'search' | 'settings' };

export function railNavigation(from: TabId, to: RailId): RailNav {
  if (to === 'search' || to === 'settings') return { action: 'pushScreen', screen: to };
  return tabNavigation(from, to);
}

/**
 * The tab of the screen under a nested screen (the library grid, pushed over Movies/Series browse or Start). Unknown:
 * the grid's own kind.
 */
export function belowTab(screen: string | undefined, kind: VodKind | undefined, ownKind: VodKind): TabId {
  if (screen === 'start') return 'start';
  if (screen === 'home') return 'live';
  return tabOfKind(screen === 'vod' ? kind ?? ownKind : ownKind);
}

export type NestedRailStep = { action: 'pop' } | { action: 'replaceScreen'; screen: 'search' | 'settings' } | Exclude<RailNav, { action: 'none' }>;

/** What lies under Search or Settings: a tab's screen, or the library grid over the tab `overGrid`. */
export type RailBelow = TabId | { overGrid: TabId };

interface EntryLike { screen: string; params?: Record<string, unknown> }
const kindParam = (e: EntryLike | undefined) => e?.params?.kind as VodKind | undefined;

/**
 * The screens under Search or Settings (`lower` right below it, `under` below that) as the rail sees them: a tab's
 * screen, the library grid with the tab of the screen under it, or unknown (a tab choice then only pops).
 */
export function railBelow(lower: EntryLike | undefined, under: EntryLike | undefined): RailBelow | undefined {
  if (lower?.screen === 'vodGrid') return { overGrid: belowTab(under?.screen, kindParam(under), kindParam(lower) ?? 'movie') };
  if (lower?.screen === 'home' || lower?.screen === 'start' || lower?.screen === 'vod') {
    return belowTab(lower.screen, kindParam(lower), 'movie');
  }
  return undefined;
}

/**
 * A rail choice on a nested screen.
 * - The library grid (`railFromNested(below, to)`): Search and Settings are pushed over it; a tab first pops it, then
 *   moves as the screen below (`below`) would, so the stack never keeps a stale tab.
 * - Search or Settings (`railFromNested(from, below, to)`; `below` from `railBelow`): its own id does nothing, the
 *   other one replaces it (they never stack), a tab pops it, then moves as `below` would (Live TV below: the pop is
 *   enough; the library grid: as the grid would, popping it too; unknown: the pop only).
 */
export function railFromNested(below: TabId, to: RailId): NestedRailStep[];
export function railFromNested(from: 'search' | 'settings', below: RailBelow | undefined, to: RailId): NestedRailStep[];
export function railFromNested(a: TabId | 'search' | 'settings', b: RailBelow | RailId | undefined, c?: RailId): NestedRailStep[] {
  if (c !== undefined) {
    const from = a as 'search' | 'settings';
    if (c === from) return [];
    if (c === 'search' || c === 'settings') return [{ action: 'replaceScreen', screen: c }];
    if (b === undefined) return [{ action: 'pop' }];
    if (typeof b === 'object') return [{ action: 'pop' }, ...railFromNested(b.overGrid, c)];
    const nav = railNavigation(b as TabId, c);
    return nav.action === 'none' ? [{ action: 'pop' }] : [{ action: 'pop' }, nav as Exclude<RailNav, { action: 'none' }>];
  }
  const nav = railNavigation(a as TabId, b as RailId);
  if (nav.action === 'pushScreen') return [nav];
  return nav.action === 'none' ? [{ action: 'pop' }] : [{ action: 'pop' }, nav];
}
