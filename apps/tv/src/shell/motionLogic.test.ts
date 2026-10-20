import { describe, expect, test } from 'vitest';
import { EASE, MOTION } from './theme.ts';
import { classifyGap, effectiveLevel, isNavKey, KeyCadence, nextMotionLevel, parseMotionLevel, planMotion, screenEnters, type MotionContext } from './motionLogic.ts';

const ctx = (o: Partial<MotionContext> = {}): MotionContext => ({ level: 'full', cadence: 'normal', gap: undefined, live: 0, ...o });

describe('classifyGap', () => {
  test('first press and slow presses are normal', () => {
    expect(classifyGap(undefined)).toBe('normal');
    expect(classifyGap(250)).toBe('normal');
    expect(classifyGap(900)).toBe('normal');
  });
  test('120 to 250 ms is brisk, below 120 ms a held key', () => {
    expect(classifyGap(249)).toBe('brisk');
    expect(classifyGap(120)).toBe('brisk');
    expect(classifyGap(119)).toBe('repeat');
    expect(classifyGap(40)).toBe('repeat');
  });
});

describe('KeyCadence', () => {
  test('no key yet: normal', () => {
    expect(new KeyCadence().current(1000)).toBe('normal');
  });
  test('the cadence comes from the gap between the last two navigation keydowns', () => {
    const k = new KeyCadence();
    k.down(1000);
    expect(k.current(1000)).toBe('normal');
    k.down(1200);
    expect(k.current(1200)).toBe('brisk');
    expect(k.gap()).toBe(200);
    k.down(1250);
    expect(k.current(1250)).toBe('repeat');
    expect(k.held(1260)).toBe(true);
  });
  test('a keyup settles to normal at once, and the next keydown measures again', () => {
    const k = new KeyCadence();
    k.down(1000);
    k.down(1050);
    k.up();
    expect(k.current(1060)).toBe('normal');
    expect(k.held(1060)).toBe(false);
    k.down(1100);
    expect(k.current(1100)).toBe('repeat');
  });
  test('no key for the settle time: normal again (a missed keyup)', () => {
    const k = new KeyCadence();
    k.down(1000);
    k.down(1050);
    expect(k.current(1050 + MOTION.settle - 1)).toBe('repeat');
    expect(k.current(1050 + MOTION.settle)).toBe('normal');
  });
});

describe('isNavKey', () => {
  test('arrows and channel keys are navigation; OK and Back are not', () => {
    for (const k of ['Up', 'Down', 'Left', 'Right', 'ChannelUp', 'ChannelDown']) expect(isNavKey(k)).toBe(true);
    for (const k of ['Ok', 'LongOk', 'Back', 'Menu', 'Digit1']) expect(isNavKey(k)).toBe(false);
  });
});

describe('planMotion', () => {
  test('normal cadence, full level: the token as is', () => {
    expect(planMotion(MOTION.focusIn, 'move', ctx())).toEqual({ ms: 120, ease: EASE.standard });
    expect(planMotion(MOTION.imageIn, 'fade', ctx())).toEqual({ ms: 160, ease: EASE.fade });
  });
  test('brisk: focus and scroll at 0.6, fades and ui unchanged', () => {
    expect(planMotion(MOTION.focusIn, 'move', ctx({ cadence: 'brisk', gap: 200 })).ms).toBe(72);
    expect(planMotion(MOTION.rowScroll, 'move', ctx({ cadence: 'brisk', gap: 200 })).ms).toBe(108);
    expect(planMotion(MOTION.imageIn, 'fade', ctx({ cadence: 'brisk', gap: 200 })).ms).toBe(160);
    expect(planMotion(MOTION.menuIn, 'move', ctx({ cadence: 'brisk', gap: 200 })).ms).toBe(160);
  });
  test('held key: focus scale and image fades snap, the row scroll glides linearly for the key gap', () => {
    const held = ctx({ cadence: 'repeat', gap: 60 });
    expect(planMotion(MOTION.focusIn, 'move', held).ms).toBe(0);
    expect(planMotion(MOTION.focusOut, 'move', held).ms).toBe(0);
    expect(planMotion(MOTION.imageIn, 'fade', held).ms).toBe(0);
    expect(planMotion(MOTION.rowScroll, 'move', held)).toEqual({ ms: 60, ease: EASE.glide });
    expect(planMotion(MOTION.menuIn, 'fade', held).ms).toBe(160);
  });
  test('a glide never runs longer than the token', () => {
    expect(planMotion(MOTION.rowScroll, 'move', ctx({ cadence: 'repeat', gap: 119 })).ms).toBe(119);
    expect(planMotion({ ms: 50, ease: EASE.standard, kind: 'scroll' }, 'move', ctx({ cadence: 'repeat', gap: 100 })).ms).toBe(50);
  });
  test('reduced: movement snaps, fades are capped at 150 ms', () => {
    const r = ctx({ level: 'reduced' });
    expect(planMotion(MOTION.focusIn, 'move', r).ms).toBe(0);
    expect(planMotion(MOTION.rowScroll, 'move', r).ms).toBe(0);
    expect(planMotion(MOTION.menuIn, 'move', r).ms).toBe(0);
    expect(planMotion(MOTION.backdrop, 'fade', r)).toEqual({ ms: 150, ease: EASE.fade });
    expect(planMotion(MOTION.imageIn, 'fade', r).ms).toBe(150);
  });
  test('off: everything snaps', () => {
    const o = ctx({ level: 'off' });
    expect(planMotion(MOTION.backdrop, 'fade', o).ms).toBe(0);
    expect(planMotion(MOTION.focusIn, 'move', o).ms).toBe(0);
  });
  test('at the live-animation cap, new animations snap', () => {
    expect(planMotion(MOTION.focusIn, 'move', ctx({ live: MOTION.maxLive - 1 })).ms).toBe(120);
    expect(planMotion(MOTION.focusIn, 'move', ctx({ live: MOTION.maxLive })).ms).toBe(0);
  });
});

describe('effectiveLevel', () => {
  test('during playback the level is reduced at most', () => {
    expect(effectiveLevel('full', true)).toBe('reduced');
    expect(effectiveLevel('reduced', true)).toBe('reduced');
    expect(effectiveLevel('off', true)).toBe('off');
    expect(effectiveLevel('full', false)).toBe('full');
  });
});

describe('nextMotionLevel', () => {
  test('Full, Reduced, Off, then Full again', () => {
    expect(nextMotionLevel('full')).toBe('reduced');
    expect(nextMotionLevel('reduced')).toBe('off');
    expect(nextMotionLevel('off')).toBe('full');
  });
});

describe('parseMotionLevel', () => {
  test('a stored setting wins; else the reduced-motion preference', () => {
    expect(parseMotionLevel('off', false)).toBe('off');
    expect(parseMotionLevel('full', true)).toBe('full');
    expect(parseMotionLevel(undefined, true)).toBe('reduced');
    expect(parseMotionLevel(undefined, false)).toBe('full');
    expect(parseMotionLevel('bogus', false)).toBe('full');
  });
});

describe('screenEnters', () => {
  test('a screen pushed or switched to (rail tabs replace) fades in', () => {
    expect(screenEnters('push', 'movieDetail')).toBe(true);
    expect(screenEnters('replace', 'vod')).toBe(true);
    expect(screenEnters('push', 'settings')).toBe(true);
  });

  test('not between two rail screens: the rail stays put, so the screen does not blink it', () => {
    expect(screenEnters('replace', 'vod', true)).toBe(false);
    expect(screenEnters('push', 'search', true)).toBe(false);
  });

  test('never for video screens (Player, VodPlay, Live TV), cold start (reset) or Back', () => {
    expect(screenEnters('push', 'player')).toBe(false);
    expect(screenEnters('replace', 'vodPlay')).toBe(false);
    expect(screenEnters('push', 'home')).toBe(false);
    expect(screenEnters('reset', 'start')).toBe(false);
    expect(screenEnters('back', 'vod')).toBe(false);
    expect(screenEnters(undefined, 'vod')).toBe(false);
  });
});
