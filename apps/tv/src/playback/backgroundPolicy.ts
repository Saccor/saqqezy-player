/** What to do with the stream when the app goes to the background and comes back (Tizen multitasking). */
export type BackgroundAction =
  | { kind: 'none' }
  | { kind: 'close-live' }
  | { kind: 'suspend-vod'; positionMs: number }
  /** A VOD title that is not playing yet (loading, reconnecting): nothing to suspend, and no retry may run hidden. */
  | { kind: 'close-vod'; positionMs: number };

export type ForegroundAction =
  | { kind: 'none' }
  | { kind: 'reopen-live' }
  | { kind: 'wait-network' }
  | { kind: 'resume-vod'; positionMs: number }
  | { kind: 'reopen-vod'; positionMs: number };

export function onHidden(s: { playing: 'live' | 'vod' | 'vod-loading' | 'none'; positionMs?: number }): BackgroundAction {
  if (s.playing === 'live') return { kind: 'close-live' };
  if (s.playing === 'vod') return { kind: 'suspend-vod', positionMs: Math.max(0, s.positionMs ?? 0) };
  if (s.playing === 'vod-loading') return { kind: 'close-vod', positionMs: Math.max(0, s.positionMs ?? 0) };
  return { kind: 'none' };
}

export function onVisible(b: BackgroundAction, s: { networkUp: boolean }): ForegroundAction {
  if (b.kind === 'close-live') return s.networkUp ? { kind: 'reopen-live' } : { kind: 'wait-network' };
  if (b.kind === 'suspend-vod') return { kind: 'resume-vod', positionMs: b.positionMs };
  if (b.kind === 'close-vod') return { kind: 'reopen-vod', positionMs: b.positionMs };
  return { kind: 'none' };
}
