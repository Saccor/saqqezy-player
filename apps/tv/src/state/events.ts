import type { AppEvent, InitState } from '@iptv/app-api';
import type { ScreenEntry } from '../shell/router.ts';

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
