/** The left rail (UI revamp spec §1.3). Pure: no Solid, no Lightning. */
import type { IconKind } from '../vod/icons.ts';
import { tabNavigation, type TabId, type TabNav } from '../vod/tabLogic.ts';
import { LAYOUT } from './theme.ts';

export type RailId = TabId | 'search' | 'settings';

export const RAIL_ITEMS: readonly RailId[] = ['start', 'live', 'movies', 'series', 'search', 'settings'];
export const RAIL_LABELS: Record<RailId, string> = {
  start: 'Start', live: 'Live TV', movies: 'Movies', series: 'Series', search: 'Search', settings: 'Settings',
};
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
