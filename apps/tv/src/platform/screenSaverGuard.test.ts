import { describe, expect, it } from 'vitest';
import { createScreenSaverGuard, createSharedSaver, desiredScreenSaver, type SaverInput } from './screenSaverGuard.ts';

const base: SaverInput = { fullscreen: true, video: true, paused: false };

describe('desiredScreenSaver', () => {
  it.each<[Partial<SaverInput>, 'on' | 'off']>([
    [{}, 'off'],
    [{ paused: true }, 'on'],
    [{ fullscreen: false }, 'on'],
    [{ video: false }, 'on'],
  ])('%j → %s', (patch, want) => {
    expect(desiredScreenSaver({ ...base, ...patch })).toBe(want);
  });
});

describe('createScreenSaverGuard', () => {
  it('calls the bridge only on change and survives a throwing bridge', () => {
    const calls: string[] = [];
    const g = createScreenSaverGuard((s) => { calls.push(s); if (calls.length === 1) throw new Error('x'); });
    g.update(base);
    g.update(base);
    g.update({ ...base, paused: true });
    g.update({ ...base, paused: true });
    expect(calls).toEqual(['off', 'on']);
  });
});

describe('createSharedSaver', () => {
  it('stays off while any member wants it off, and only sets on a change', () => {
    const set: string[] = [];
    const shared = createSharedSaver((s) => set.push(s));
    const a = shared.member();
    const b = shared.member();
    a('off');
    b('on');
    expect(set).toEqual(['off']);
    a('on');
    expect(set).toEqual(['off', 'on']);
    b('off');
    a('off');
    b('on');
    expect(set).toEqual(['off', 'on', 'off']);
  });

  it('a member that never reported counts as on', () => {
    const set: string[] = [];
    const shared = createSharedSaver((s) => set.push(s));
    shared.member();
    const b = shared.member();
    b('on');
    expect(set).toEqual(['on']);
  });

  it('a throwing setter is swallowed', () => {
    const shared = createSharedSaver(() => { throw new Error('no api'); });
    expect(() => shared.member()('off')).not.toThrow();
  });
});
