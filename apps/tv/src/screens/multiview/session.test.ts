import { describe, expect, it, vi } from 'vitest';
import type { PlayableChannel } from '@iptv/app-api';
import { layout } from './layout.ts';
import { addWindow, start } from './mvLogic.ts';
import { createMultiviewSession, type SessionSlot } from './session.ts';

const ch = (id: string): PlayableChannel => ({ id, number: 1, name: `Channel ${id}`, group: 'g', favourite: false, url: `http://a.example.test/${id}.ts` });

function fakeSlot(n: number, log: string[]): SessionSlot {
  let current: PlayableChannel | undefined;
  return {
    n,
    player: {
      setMuted: (m) => { log.push(`${n}:muted:${m}`); },
      setEngineOverrides: (o) => { log.push(`${n}:overrides:${o ? Object.keys(o.hls ?? {}).join('+') : 'none'}`); },
    },
    playback: {
      setRect: (r) => { log.push(`${n}:rect:${r === 'fullscreen' ? 'full' : `${r.x},${r.y},${r.w}`}`); },
      playChannel: (c, o) => { current = c; log.push(`${n}:play:${c.id}${o?.countOpen ? ':counted' : ''}`); return true; },
      stop: () => { current = undefined; log.push(`${n}:stop`); },
      current: () => current,
    },
  };
}

function setup(primaryChannel = 'c0') {
  const log: string[] = [];
  const slots = new Map<number, SessionSlot>([[0, fakeSlot(0, log)]]);
  (slots.get(0)!.playback as { playChannel: (c: PlayableChannel) => boolean }).playChannel(ch(primaryChannel));
  log.length = 0;
  let primary = 0;
  const pool = {
    max: 4,
    slot: (n: number) => { let s = slots.get(n); if (!s) slots.set(n, (s = fakeSlot(n, log))); return s; },
    primary: () => primary,
    setPrimary: vi.fn((n: number) => { primary = n; log.push(`primary:${n}`); }),
    release: vi.fn(() => { for (const [n] of slots) if (n !== primary) slots.delete(n); log.push('release'); }),
  };
  const setInMultiview = vi.fn((open: boolean) => { log.push(`multiview:${open}`); });
  const session = createMultiviewSession({
    pool, setInMultiview,
    fetch: (id) => Promise.resolve(id === 'missing' ? undefined : ch(id)),
    profile: (cls) => ({ hls: cls === 'small' ? { capLevelToPlayerSize: true, maxBufferSize: 1 } : { capLevelToPlayerSize: true } }),
  });
  return { log, pool, session, setInMultiview };
}

describe('createMultiviewSession', () => {
  it('entering keeps the playing channel as window 1 with no new play', () => {
    const { log, session } = setup();
    const first = session.enter();
    expect(first).toEqual({ slot: 0, channelId: 'c0' });
    expect(log).toEqual(['multiview:true']);
  });

  it('entering with nothing playing gives no window', () => {
    const { session, pool } = setup();
    pool.slot(0).playback.stop();
    expect(session.enter()).toBeUndefined();
  });

  it('a window opens in a free slot: muted, sized, placed, then one counted play', async () => {
    const { log, session } = setup();
    session.enter();
    log.length = 0;
    const l = layout({ tiles: 2, windowLimit: 2 });
    const opened = await session.openWindow('c7', [{ slot: 0, channelId: 'c0' }], l.tiles[1]!);
    expect(opened).toEqual({ slot: 1, channelId: 'c7' });
    expect(log).toEqual(['1:muted:true', '1:overrides:capLevelToPlayerSize', '1:rect:968,288,896', '1:play:c7:counted']);
  });

  it('a channel the source no longer has opens nothing', async () => {
    const { log, session } = setup();
    session.enter();
    log.length = 0;
    expect(await session.openWindow('missing', [{ slot: 0, channelId: 'c0' }], layout({ tiles: 2, windowLimit: 2 }).tiles[1]!)).toBeUndefined();
    expect(log.filter((e) => e.includes('play'))).toEqual([]);
  });

  it('applying a layout moves every window to its rect and never plays', () => {
    const { log, session } = setup();
    const s = addWindow(start({ slot: 0, channelId: 'c0' }), { slot: 1, channelId: 'c1' });
    log.length = 0;
    session.apply(s, 2);
    expect(log).toEqual(['0:rect:56,288,896', '1:rect:968,288,896']);
  });

  it('full screen: that window fills the screen, the others shrink to nothing and keep playing', () => {
    const { log, session } = setup();
    const s = { ...addWindow(start({ slot: 0, channelId: 'c0' }), { slot: 1, channelId: 'c1' }), fullScreen: 1, sound: 1 };
    log.length = 0;
    session.apply(s, 2);
    expect(log.filter((e) => e.includes(':rect:'))).toEqual(['0:rect:0,0,0', '1:rect:full']);
    expect(log.some((e) => e.includes(':stop') || e.includes(':play:'))).toBe(false);
  });

  it('the sound follows the state: the pool primary moves, no play', () => {
    const { log, pool, session } = setup();
    let s = addWindow(start({ slot: 0, channelId: 'c0' }), { slot: 1, channelId: 'c1' });
    s = { ...s, sound: 1 };
    session.apply(s, 2);
    expect(pool.setPrimary).toHaveBeenCalledWith(1);
    expect(log.some((e) => e.includes(':play:'))).toBe(false);
  });

  it('leaving keeps the window with sound playing full screen and frees the others: no play', () => {
    const { log, pool, session } = setup();
    pool.slot(1);
    pool.setPrimary(1);
    log.length = 0;
    session.leave();
    expect(log).toEqual(['release', 'multiview:false', '1:overrides:none', '1:muted:false', '1:rect:full']);
  });
});
