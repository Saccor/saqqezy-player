import { describe, expect, test, vi } from 'vitest';
import { createLiveReturn } from '../vod/liveReturn.ts';
import { createParkLive } from './parkLive.ts';

const PREVIEW = { x: 100, y: 100, w: 640, h: 360 };

const setup = (s: { currentId?: string; statusKind?: string; fullscreen?: boolean; sourceId?: string }) => {
  const liveReturn = createLiveReturn();
  const stop = vi.fn();
  const setRect = vi.fn();
  const park = createParkLive({
    currentId: () => s.currentId,
    statusKind: () => s.statusKind,
    rectIsFullscreen: () => s.fullscreen === true,
    activeSourceId: () => s.sourceId ?? 'src1',
    stop,
    setRect,
    liveReturn,
  });
  return { park, liveReturn, stop, setRect };
};

describe('parkLiveForScreen', () => {
  test("'stop': remembers a playing channel for Home and stops the stream", () => {
    const { park, liveReturn, stop, setRect } = setup({ currentId: 'c1', statusKind: 'playing', fullscreen: true });
    park('stop');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(setRect).not.toHaveBeenCalled();
    expect(liveReturn.take('src1')).toEqual({ id: 'c1', fromSearch: false });
  });

  test("'stop': a failed channel, a VOD stand-in or nothing playing is stopped but not remembered", () => {
    for (const s of [{ currentId: 'c1', statusKind: 'failed' }, { currentId: 'vod:m1', statusKind: 'playing' }, {}]) {
      const { park, liveReturn, stop } = setup(s);
      park('stop');
      expect(stop).toHaveBeenCalledTimes(1);
      expect(liveReturn.take('src1')).toBeUndefined();
    }
  });

  test("'stop' keeps an earlier remembered channel when nothing plays now (Start, then its Sports screen)", () => {
    const { park, liveReturn, stop } = setup({});
    liveReturn.remember('c9', 'src1');
    park('stop');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(liveReturn.take('src1')?.id).toBe('c9');
  });

  test('{ preview }: a fullscreen video (Back from the Player) moves to the preview window; nothing else changes', () => {
    const full = setup({ currentId: 'c1', statusKind: 'playing', fullscreen: true });
    full.park({ preview: PREVIEW });
    expect(full.setRect).toHaveBeenCalledWith(PREVIEW);
    expect(full.stop).not.toHaveBeenCalled();
    expect(full.liveReturn.take('src1')).toBeUndefined();
    const small = setup({ currentId: 'c1', statusKind: 'playing', fullscreen: false });
    small.park({ preview: PREVIEW });
    expect(small.setRect).not.toHaveBeenCalled();
    expect(small.stop).not.toHaveBeenCalled();
  });
});
