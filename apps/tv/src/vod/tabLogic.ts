/** The top tab bar shared by Start, Home (Live TV), Movies and Series. Pure: no Solid, no Lightning. */
import type { VodKind } from '@iptv/core';

export type { VodKind };
export type TabId = 'start' | 'live' | 'movies' | 'series';

export const TABS: readonly TabId[] = ['start', 'live', 'movies', 'series'];
export const TAB_LABELS: Record<TabId, string> = { start: 'Start', live: 'Live TV', movies: 'Movies', series: 'Series' };
/** 124: four tabs end left of the phone badge, which must stay clear of the wordmark (x 810). */
export const TAB_W = 124;
export const TAB_H = 52;
export const TAB_GAP = 8;
export const TABS_W = TABS.length * TAB_W + (TABS.length - 1) * TAB_GAP;
/** Focus resting this long on another tab switches to it (passing over a tab does not load it). */
export const TAB_SWITCH_MS = 150;

export function stepTab(t: TabId, d: 1 | -1): TabId {
  const i = Math.max(0, Math.min(TABS.length - 1, TABS.indexOf(t) + d));
  return TABS[i]!;
}

/** The tab under a node-local x, undefined in a gap or outside. */
export function tabAt(x: number): TabId | undefined {
  if (x < 0 || x >= TABS_W) return undefined;
  const i = Math.floor(x / (TAB_W + TAB_GAP));
  return x - i * (TAB_W + TAB_GAP) < TAB_W ? TABS[i] : undefined;
}


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
