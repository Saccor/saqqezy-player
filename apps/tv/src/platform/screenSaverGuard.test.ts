import { describe, expect, it } from 'vitest';
import { createScreenSaverGuard, desiredScreenSaver, type SaverInput } from './screenSaverGuard.ts';

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
