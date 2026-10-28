import { describe, expect, it, vi } from 'vitest';
import { createLiveSoundWatch, liveNoSoundText } from './liveSound.ts';
import { FAILURE_COPY } from '../copy.ts';

describe('liveNoSoundText', () => {
  it('says the same as the movie player; with more than one track it points at Options', () => {
    expect(liveNoSoundText(1)).toBe(FAILURE_COPY.noSound);
    expect(liveNoSoundText(0)).toBe(FAILURE_COPY.noSound);
    expect(liveNoSoundText(2)).toBe(FAILURE_COPY.noSoundTryTrack);
    expect(FAILURE_COPY.noSoundTryTrack).toContain('Options');
  });
});

describe('createLiveSoundWatch', () => {
  const setup = (o: { id?: string; silent?: boolean; tracks?: number } = {}) => {
    const s = { id: o.id ?? 'c1' as string | undefined, silent: o.silent ?? true, tracks: o.tracks ?? 1 };
    const toast = vi.fn();
    const watch = createLiveSoundWatch({
      channelId: () => s.id,
      soundUndecodable: () => s.silent,
      audioTrackCount: () => s.tracks,
      toast,
    });
    return { s, toast, watch };
  };

  it('says so once per channel while it plays silently', () => {
    const { toast, watch } = setup();
    watch.tick();
    watch.tick();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(liveNoSoundText(1));
  });

  it('nothing while the sound plays or nothing is playing', () => {
    const { s, toast, watch } = setup({ silent: false });
    watch.tick();
    s.id = undefined;
    s.silent = true;
    watch.tick();
    expect(toast).not.toHaveBeenCalled();
  });

  it('another silent channel says so again; going back to one already told does not', () => {
    const { s, toast, watch } = setup({ tracks: 2 });
    watch.tick();
    s.id = 'c2';
    watch.tick();
    s.id = 'c1';
    watch.tick();
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenLastCalledWith(liveNoSoundText(2));
  });
});
