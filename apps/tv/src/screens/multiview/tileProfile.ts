import type { SizeClass } from './layout.ts';

/**
 * How hard a multiview tile may work its engine (spec 2026-10-20-multiview §7.4). Small tiles are capped near their
 * size and keep little buffer, so 4 tiles fit a TV's memory; Large tiles play as usual. Every tile uses the `stable`
 * live delay and learns no live target (the single view's learned delay stays its own). Pure.
 */
export interface TileProfile {
  preset: 'stable';
  learnLiveTarget: false;
  hls: { capLevelToPlayerSize: true; maxBufferSize?: number; backBufferLength?: number; maxBufferLength?: number };
  mpegts: {
    stashInitialSize?: number;
    autoCleanupSourceBuffer?: true;
    autoCleanupMaxBackwardDuration?: number;
    autoCleanupMinBackwardDuration?: number;
  };
  /** Android (P3): `setMaxVideoSize`, and the audio renderer off while the tile is muted. */
  media3: { maxVideoSize: [number, number]; audioOffWhenMuted: boolean };
  /** PC: a scale cap in the video filter, and `aid=no` while the tile is muted. */
  mpv: { scaleCap?: [number, number]; audioOffWhenMuted: boolean };
}

const SMALL_SIZE: [number, number] = [960, 540];

export function tileProfile(sizeClass: SizeClass, isTv: boolean): TileProfile {
  if (sizeClass === 'large') {
    return {
      preset: 'stable', learnLiveTarget: false,
      hls: { capLevelToPlayerSize: true },
      mpegts: {},
      media3: { maxVideoSize: [1920, 1080], audioOffWhenMuted: false },
      mpv: { audioOffWhenMuted: false },
    };
  }
  return {
    preset: 'stable', learnLiveTarget: false,
    hls: { capLevelToPlayerSize: true, maxBufferSize: isTv ? 8_000_000 : 20_000_000, backBufferLength: 0, maxBufferLength: 6 },
    mpegts: { stashInitialSize: 128 * 1024, autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 10, autoCleanupMinBackwardDuration: 5 },
    media3: { maxVideoSize: SMALL_SIZE, audioOffWhenMuted: true },
    mpv: { scaleCap: SMALL_SIZE, audioOffWhenMuted: true },
  };
}
