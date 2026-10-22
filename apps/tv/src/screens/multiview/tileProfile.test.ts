import { describe, expect, it } from 'vitest';
import { tileProfile } from './tileProfile.ts';

describe('tileProfile (spec §7.4)', () => {
  it('a Large-class tile: level capped to its size, normal buffers, full HD on native engines', () => {
    for (const isTv of [false, true]) {
      expect(tileProfile('large', isTv)).toEqual({
        preset: 'stable',
        learnLiveTarget: false,
        hls: { capLevelToPlayerSize: true },
        mpegts: {},
        media3: { maxVideoSize: [1920, 1080], audioOffWhenMuted: false },
        mpv: { audioOffWhenMuted: false },
      });
    }
  });

  it('a small tile on a TV: 8 MB, no back buffer, about 6 s ahead, 960x540, muted audio off', () => {
    expect(tileProfile('small', true)).toEqual({
      preset: 'stable',
      learnLiveTarget: false,
      hls: { capLevelToPlayerSize: true, maxBufferSize: 8_000_000, backBufferLength: 0, maxBufferLength: 6 },
      mpegts: { stashInitialSize: 128 * 1024, autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 10, autoCleanupMinBackwardDuration: 5 },
      media3: { maxVideoSize: [960, 540], audioOffWhenMuted: true },
      mpv: { scaleCap: [960, 540], audioOffWhenMuted: true },
    });
  });

  it('a small tile on desktop keeps 20 MB of buffer', () => {
    expect(tileProfile('small', false).hls).toEqual({ capLevelToPlayerSize: true, maxBufferSize: 20_000_000, backBufferLength: 0, maxBufferLength: 6 });
  });
});
