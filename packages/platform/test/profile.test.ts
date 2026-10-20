import { describe, expect, it } from 'vitest';
import { profileFor, type PlatformId } from '../src/index.ts';

const rows: Array<[PlatformId, boolean, boolean, boolean, boolean]> = [
  // id, isTv, pointer, filePicker/volumeUi/clipboard, rateCatchUp
  ['browser', false, true, true, true],
  ['desktop', false, true, true, true],
  ['tizen', true, false, false, false],
  ['webos', true, true, false, false],
  ['androidtv', true, false, false, false],
];

describe('profileFor', () => {
  it.each(rows)('%s', (id, isTv, pointer, desk, rate) => {
    const p = profileFor(id);
    expect(p.id).toBe(id);
    expect(p.isTv).toBe(isTv);
    expect(p.pointer).toBe(pointer);
    expect([p.filePicker, p.volumeUi, p.clipboard]).toEqual([desk, desk, desk]);
    expect(p.rateCatchUp).toBe(rate);
    expect(p.debugHud).toBe(!isTv);
  });
  it('registers Tizen keys only on tizen, with the media keys', () => {
    expect(profileFor('tizen').registerKeys).toEqual(expect.arrayContaining(['MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind']));
    expect(profileFor('webos').registerKeys).toEqual([]);
  });
  it('only webOS toggles on the Play key', () => {
    expect((['browser', 'desktop', 'tizen', 'webos', 'androidtv'] as PlatformId[]).filter((id) => profileFor(id).playKeyToggles)).toEqual(['webos']);
  });
  it('returns a fresh, frozen object', () => {
    expect(Object.isFrozen(profileFor('desktop'))).toBe(true);
  });
});
