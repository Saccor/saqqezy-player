/** The top tab bar shared by Home (Live TV) and the Movies screens. Pure: no Solid, no Lightning. */
export type TabId = 'live' | 'movies';

/** Series joins in Plan 5. */
export const TABS: readonly TabId[] = ['live', 'movies'];
export const TAB_LABELS: Record<TabId, string> = { live: 'Live TV', movies: 'Movies' };
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

export type TabNav = { action: 'none' } | { action: 'back' } | { action: 'push'; kind: 'movie' } | { action: 'replace'; kind: 'movie' };

/** Live TV is Home (the screen below); a VOD tab is the `vod` screen pushed over it. */
export function tabNavigation(from: TabId, to: TabId): TabNav {
  if (from === to) return { action: 'none' };
  if (to === 'live') return { action: 'back' };
  return from === 'live' ? { action: 'push', kind: 'movie' } : { action: 'replace', kind: 'movie' };
}
