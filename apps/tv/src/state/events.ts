import type { AppEvent, InitState } from '@iptv/app-api';
import type { ScreenEntry, ScreenId } from '../shell/router.ts';

/** The root screen for a fresh start: Add source without sources, otherwise Home at the last position. */
export function initialRoute(s: InitState): ScreenEntry {
  if (s.sources.length === 0) return { screen: 'addSource', params: {} };
  const params: Record<string, unknown> = {};
  if (s.lastGroupId !== undefined) params.lastGroupId = s.lastGroupId;
  if (s.lastChannelId !== undefined) params.lastChannelId = s.lastChannelId;
  return { screen: 'home', params };
}

/** Neutral toast copy for a worker event, or undefined when the event shows no toast. */
export function toastFor(e: AppEvent): string | undefined {
  // Changes made on this device need no toast; a paired companion's do.
  if (e.type === 'layoutChanged' || e.type === 'sourcesChanged') return e.origin === 'remote' ? 'Updated from your phone' : undefined;
  if (e.type !== 'refreshFailed') return undefined;
  return e.what === 'playlist' ? "Couldn't refresh channels. Showing saved list." : "Couldn't refresh the TV guide.";
}

/**
 * Toast precedence for a worker event: a failed channel refresh matters more than a failed guide refresh, so
 * a guide toast arriving right after it waits instead of replacing it.
 */
export function toastPriority(e: AppEvent): number {
  return e.type === 'refreshFailed' && e.what === 'playlist' ? 1 : 0;
}

/**
 * Offline badge state after an event. Mirrors the worker's rule: a network failure without an HTTP status
 * means offline; any successful refresh means online again.
 */
export function offlineAfter(prev: boolean, e: AppEvent): boolean {
  switch (e.type) {
    case 'offline': return e.value;
    case 'refreshed': return false;
    case 'refreshFailed': return e.error.name === 'SourceNetworkError' && e.error.status === undefined ? true : prev;
    default: return prev;
  }
}

export type SourcesChanged = Extract<AppEvent, { type: 'sourcesChanged' }>;

/** What the shell does when the active source or the source list changed. */
export interface SourcesReaction {
  /** Re-run `api.init()` and apply the answer. */
  applyState: boolean;
  /** No sources remain: the root becomes Add source. */
  resetToAddSource: boolean;
  /** The playing channel belonged to a source that is no longer active (removed or deactivated). */
  stopPlayback: boolean;
  /** The fullscreen Player lost its channel: go back to a fresh Home. */
  leavePlayer: boolean;
  /** The first source arrived while Add source was the empty root: open Home. */
  openHome: boolean;
}

const NONE: SourcesReaction = { applyState: false, resetToAddSource: false, stopPlayback: false, leavePlayer: false, openHome: false };

/**
 * Pure decision for a `sourcesChanged` event. Changes made on this device (`local`) are already applied by the
 * screen that made them (Settings and Add source call `applyInitState` and stop playback themselves), so they
 * are ignored here: nothing is applied twice. A paired phone's changes (`remote`) are applied here; Home and the
 * Guide re-read their lists on the same event. `prevActiveId` is the state before the change, and
 * `playing` whether a channel is playing (it always belongs to the previous active source).
 */
export function sourcesReaction(
  e: SourcesChanged,
  prev: Pick<InitState, 'activeSourceId' | 'sources'> | undefined,
  route: ScreenId | undefined,
  playing: boolean,
): SourcesReaction {
  if (e.origin !== 'remote') return NONE;
  const resetToAddSource = e.activeSourceId === undefined && route !== 'addSource';
  const stopPlayback = playing && prev?.activeSourceId !== e.activeSourceId;
  return {
    applyState: true,
    resetToAddSource,
    stopPlayback,
    leavePlayer: !resetToAddSource && stopPlayback && route === 'player',
    openHome: e.activeSourceId !== undefined && route === 'addSource' && (prev?.sources.length ?? 0) === 0,
  };
}
