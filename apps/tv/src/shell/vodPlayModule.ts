import type { ScreenEntry } from './router.ts';
import { lazyModule } from './lazyModule.ts';

/**
 * The movie, series and catch-up player, loaded on first use (no cold start opens it: startup resumes a live channel).
 * The App preloads it in idle time after the first frame, and the detail screens ask for it when they open, so the
 * first Play does not wait for the chunk.
 */
export const vodPlayModule = lazyModule<{ entry: ScreenEntry }>(() => import('../screens/VodPlay.tsx').then((m) => m.VodPlayScreen));

/** Starts loading the player's chunk now (a no-op once it is loaded or loading); a failure shows when it opens. */
export function prefetchVodPlay(): void {
  void vodPlayModule.load().catch(() => undefined);
}
