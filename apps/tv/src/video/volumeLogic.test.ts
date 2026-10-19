import { describe, expect, test } from 'vitest';
import {
  DEFAULT_VOLUME, VOLUME_STEP, effectiveVolume, levelAt, parseVolume, serializeVolume, stepVolume, toggleMute, volumeKeyStep,
  volumePercent,
} from './volumeLogic.ts';

describe('stepVolume', () => {
  test('moves by one step and stays within 0..1', () => {
    expect(stepVolume({ level: 0.5, muted: false }, 1).level).toBeCloseTo(0.5 + VOLUME_STEP);
    expect(stepVolume({ level: 0.5, muted: false }, -1).level).toBeCloseTo(0.5 - VOLUME_STEP);
    expect(stepVolume({ level: 0.98, muted: false }, 1).level).toBe(1);
    expect(stepVolume({ level: 0.02, muted: false }, -1).level).toBe(0);
  });

  test('snaps to the step grid (no 0.30000000000000004)', () => {
    expect(stepVolume({ level: 0.25, muted: false }, 1).level).toBe(0.3);
    expect(stepVolume({ level: 0.27, muted: false }, 1).level).toBe(0.3);
    expect(stepVolume({ level: 0.27, muted: false }, -1).level).toBe(0.25);
  });

  test('stepping up unmutes; stepping down while muted stays muted', () => {
    expect(stepVolume({ level: 0.5, muted: true }, 1)).toEqual({ level: 0.55, muted: false });
    expect(stepVolume({ level: 0.5, muted: true }, -1)).toEqual({ level: 0.45, muted: true });
  });
});

describe('toggleMute', () => {
  test('flips mute and keeps the level', () => {
    expect(toggleMute({ level: 0.4, muted: false })).toEqual({ level: 0.4, muted: true });
    expect(toggleMute({ level: 0.4, muted: true })).toEqual({ level: 0.4, muted: false });
  });

  test('unmuting at level 0 brings the sound back at the default level', () => {
    expect(toggleMute({ level: 0, muted: true })).toEqual({ level: DEFAULT_VOLUME, muted: false });
    expect(toggleMute({ level: 0, muted: false })).toEqual({ level: DEFAULT_VOLUME, muted: false });
  });
});

describe('levelAt', () => {
  test('a click or drag fraction sets the level (clamped); a level above 0 unmutes', () => {
    expect(levelAt(0.42)).toEqual({ level: 0.42, muted: false });
    expect(levelAt(-0.2)).toEqual({ level: 0, muted: false });
    expect(levelAt(1.7)).toEqual({ level: 1, muted: false });
  });
});

test('effectiveVolume and volumePercent', () => {
  expect(effectiveVolume({ level: 0.6, muted: false })).toBe(0.6);
  expect(effectiveVolume({ level: 0.6, muted: true })).toBe(0);
  expect(volumePercent({ level: 0.555, muted: false })).toBe(56);
  expect(volumePercent({ level: 0.6, muted: true })).toBe(0);
});

describe('stored volume', () => {
  test('round-trips', () => {
    const s = { level: 0.35, muted: true };
    expect(parseVolume(serializeVolume(s))).toEqual(s);
  });

  test('missing or broken data gives the default', () => {
    const def = { level: DEFAULT_VOLUME, muted: false };
    expect(parseVolume(null)).toEqual(def);
    expect(parseVolume(undefined)).toEqual(def);
    expect(parseVolume('not json')).toEqual(def);
    expect(parseVolume('{"level":"loud"}')).toEqual(def);
    expect(parseVolume('{"level":7,"muted":1}')).toEqual({ level: 1, muted: false });
  });
});

describe('volumeKeyStep', () => {
  test('plus and minus keys (main row and numpad) step the volume', () => {
    expect(volumeKeyStep({ key: '+', code: 'Equal' })).toBe(1);
    expect(volumeKeyStep({ key: '=', code: 'Equal' })).toBe(1);
    expect(volumeKeyStep({ key: '+', code: 'NumpadAdd' })).toBe(1);
    expect(volumeKeyStep({ key: '-', code: 'Minus' })).toBe(-1);
    expect(volumeKeyStep({ key: '-', code: 'NumpadSubtract' })).toBe(-1);
  });

  test('other keys and modified keys (browser zoom) are not volume keys', () => {
    expect(volumeKeyStep({ key: 'a', code: 'KeyA' })).toBeUndefined();
    expect(volumeKeyStep({ key: '+', code: 'Equal', ctrlKey: true })).toBeUndefined();
    expect(volumeKeyStep({ key: '-', code: 'Minus', metaKey: true })).toBeUndefined();
  });
});
