import { describe, expect, it } from 'vitest';
import { MULTIVIEW_CEILING, canAddWindow, deviceCeiling, windowLimit } from './windows.ts';

describe('windowLimit', () => {
  it('Auto is the device ceiling; a user value above the ceiling is clamped', () => {
    expect(windowLimit(4, 'auto')).toBe(4);
    expect(windowLimit(2, 'auto')).toBe(2);
    expect(windowLimit(4, 2)).toBe(2);
    expect(windowLimit(2, 4)).toBe(2);
  });
});

describe('canAddWindow', () => {
  it("never looks at the source's connection limit: below the window limit a window can always be added", () => {
    expect(canAddWindow({ deviceMax: 4, userMax: 'auto', open: 3 })).toEqual({ ok: true });
  });

  it('at the device ceiling the reason is the device', () => {
    expect(canAddWindow({ deviceMax: 2, userMax: 'auto', open: 2 })).toEqual({ ok: false, reason: 'device', limit: 2 });
    expect(canAddWindow({ deviceMax: 2, userMax: 4, open: 2 })).toEqual({ ok: false, reason: 'device', limit: 2 });
  });

  it("at the user's Max windows below the ceiling the reason is the setting", () => {
    expect(canAddWindow({ deviceMax: 4, userMax: 2, open: 2 })).toEqual({ ok: false, reason: 'setting', limit: 2 });
  });
});

describe('deviceCeiling', () => {
  it('is what the pool allows, at most the ceiling of this phase (4 since 2026-10-22)', () => {
    expect(MULTIVIEW_CEILING).toBe(4);
    expect(deviceCeiling(4)).toBe(4);
    expect(deviceCeiling(6)).toBe(4);
    expect(deviceCeiling(1)).toBe(1);
  });
});
