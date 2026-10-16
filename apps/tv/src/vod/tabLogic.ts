/** The top tab bar shared by Home (Live TV) and the Movies and Series screens. Pure: no Solid, no Lightning. */
import type { VodKind } from '@iptv/core';

export type { VodKind };
export type TabId = 'live' | 'movies' | 'series';

export const TABS: readonly TabId[] = ['live', 'movies', 'series'];
export const TAB_LABELS: Record<TabId, string> = { live: 'Live TV', movies: 'Movies', series: 'Series' };
export const TAB_W = 132;
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

export type TabNav = { action: 'none' } | { action: 'back' } | { action: 'push'; kind: VodKind } | { action: 'replace'; kind: VodKind };

export function tabOfKind(kind: VodKind): TabId {
  return kind === 'series' ? 'series' : 'movies';
}

export function kindOfTab(tab: TabId): VodKind | undefined {
  return tab === 'movies' ? 'movie' : tab === 'series' ? 'series' : undefined;
}

/**
 * Live TV is Home (the screen below); a VOD tab is the `vod` screen pushed over it. Moving between VOD tabs replaces
 * that screen, so the stack never grows.
 */
export function tabNavigation(from: TabId, to: TabId): TabNav {
  if (from === to) return { action: 'none' };
  const kind = kindOfTab(to);
  if (!kind) return { action: 'back' };
  return from === 'live' ? { action: 'push', kind } : { action: 'replace', kind };
}
