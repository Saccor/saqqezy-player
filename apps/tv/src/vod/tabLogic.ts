/** The tabs (Start, Live TV, Movies, Series) the rail moves between. Pure: no Solid, no Lightning. */
import type { VodKind } from '@iptv/core';

export type { VodKind };
export type TabId = 'start' | 'live' | 'movies' | 'series';

export const TABS: readonly TabId[] = ['start', 'live', 'movies', 'series'];

export function tabOfKind(kind: VodKind): TabId {
  return kind === 'series' ? 'series' : 'movies';
}

export function kindOfTab(tab: TabId): VodKind | undefined {
  return tab === 'movies' ? 'movie' : tab === 'series' ? 'series' : undefined;
}

export type OverTab = { screen: 'vod'; kind: VodKind } | { screen: 'start' };
export type TabNav = { action: 'none' } | { action: 'back' } | { action: 'push' | 'replace'; to: OverTab };

/**
 * Live TV is Home (the screen below); Start, Movies and Series are screens pushed over it. Moving between those
 * replaces the top screen, so the stack never grows.
 */
export function tabNavigation(from: TabId, to: TabId): TabNav {
  if (from === to) return { action: 'none' };
  if (to === 'live') return { action: 'back' };
  const target: OverTab = to === 'start' ? { screen: 'start' } : { screen: 'vod', kind: kindOfTab(to)! };
  return { action: from === 'live' ? 'push' : 'replace', to: target };
}

export function tabParams(to: OverTab): Record<string, unknown> {
  return to.screen === 'vod' ? { kind: to.kind, focus: 'rail' } : { focus: 'rail' };
}
