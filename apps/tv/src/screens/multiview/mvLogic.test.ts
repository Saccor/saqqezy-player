import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { layout } from './layout.ts';
import {
  addWindow, click, closeWindow, enterFullScreen, equalSize, exitFullScreen, focusRested, idle, layoutInput, makeLarge, menuItems,
  FREEING_MS, FREEING_RETRY_MS, atSourceLimit, createWatchInstead, sourceLimit, windowsToStop, moveFocus, pickerHint, playingSince, pointerFocus, retryAction, soundToPlaying, start,
  steadyPlaying, togglePin, wake, type MvState,
} from './mvLogic.ts';

const w = (slot: number) => ({ slot, channelId: `c${slot}` });
const two = (): MvState => addWindow(start(w(0)), w(1));
const lay = (s: MvState, limit = 2) => layout(layoutInput(s, limit));

describe('starting and adding', () => {
  it('starts with the playing channel as window 1, with focus and sound', () => {
    const s = start(w(0));
    expect(s).toMatchObject({ windows: [w(0)], focus: 0, sound: 0, pinned: false, equal: false, chromeAwake: true });
    expect(s.large).toBeUndefined();
  });

  it('a new window takes the focus; the sound stays until focus rests', () => {
    const s = two();
    expect(s.focus).toBe(1);
    expect(s.sound).toBe(0);
    expect(focusRested(s).sound).toBe(1);
  });
});

describe('sound follows focus (owner 2026-10-22)', () => {
  it('a fast Left-Right-Left never moves the sound; resting does', () => {
    let s = focusRested(two()); // sound on window 2
    s = moveFocus(s, 'left', lay(s));
    s = moveFocus(s, 'right', lay(s));
    s = moveFocus(s, 'left', lay(s));
    expect(s.focus).toBe(0);
    expect(s.sound).toBe(1); // no rest yet
    expect(focusRested(s).sound).toBe(0);
  });

  it('hovering a window focuses it at once and moves the sound after the rest; a click moves it at once', () => {
    let s = focusRested(two());
    s = pointerFocus(s, 0);
    expect(s).toMatchObject({ focus: 0, sound: 1 });
    expect(focusRested(s).sound).toBe(0);
    expect(click(focusRested(two()), 0)).toMatchObject({ focus: 0, sound: 0 });
  });

  it('Keep sound here pins it; focus then moves alone; Sound follows focus releases it to the focus', () => {
    let s = togglePin(two(), 0);
    expect(s).toMatchObject({ pinned: true, sound: 0 });
    s = moveFocus(s, 'right', lay(s));
    s = focusRested(s);
    expect(s).toMatchObject({ focus: 1, sound: 0 });
    s = togglePin(s, 1);
    expect(s).toMatchObject({ pinned: false, sound: 1 });
  });
});

describe('focus by geometry', () => {
  it('(a): Left and Right between the two; Up and Down stay', () => {
    const s = two();
    expect(moveFocus(s, 'left', lay(s)).focus).toBe(0);
    expect(moveFocus(s, 'right', lay(s)).focus).toBe(1);
    expect(moveFocus(s, 'up', lay(s)).focus).toBe(1);
  });

  it('(b): Down from the Large window goes to the small one below its left edge, Up comes back', () => {
    const s = { ...makeLarge(two(), 1), focus: 1 };
    const down = moveFocus(s, 'down', lay(s));
    expect(down.focus).toBe(0);
    expect(moveFocus(down, 'up', lay(down)).focus).toBe(1);
  });

  it('(b) with room for a 3rd window: the empty slot is focusable', () => {
    const s = { ...makeLarge(two(), 0), focus: 1 };
    const right = moveFocus(s, 'right', lay(s, 3));
    expect(right.focus).toBe('empty');
    expect(focusRested(right).sound).toBe(s.sound); // the empty slot has no sound
    expect(moveFocus(right, 'left', lay(right, 3)).focus).toBe(1);
  });
});

describe('Make large, close and full screen', () => {
  it('Make large marks one window and clears Equal size', () => {
    expect(makeLarge({ ...two(), equal: true }, 1)).toMatchObject({ large: 1, equal: false });
  });

  it('closing to one window leaves multiview with the window that remains', () => {
    expect(closeWindow(two(), 1)).toEqual({ leave: w(0) });
    expect(closeWindow(two(), 0)).toEqual({ leave: w(1) });
  });

  it('closing the window with sound moves the sound to the new focus; a pin on it ends', () => {
    let s = addWindow(two(), w(2));
    s = togglePin(s, 2);
    const after = closeWindow(s, 2);
    if ('leave' in after) throw new Error('3 windows: stays');
    expect(after.windows).toEqual([w(0), w(1)]);
    expect(after).toMatchObject({ focus: 1, sound: 1, pinned: false });
  });

  it('closing the Large window with 3 or more left makes the next one Large; fewer left, none', () => {
    let s = addWindow(addWindow(two(), w(2)), w(3));
    s = makeLarge(s, 1);
    const three = closeWindow(s, 1);
    if ('leave' in three) throw new Error('stays');
    expect(three.large).toBe(1);
    const twoLeft = closeWindow(three, 1);
    if ('leave' in twoLeft) throw new Error('stays');
    expect(twoLeft.large).toBeUndefined();
  });

  it('full screen gives the window focus and sound; Back restores both as they were', () => {
    let s = focusRested(two()); // focus and sound on 1
    s = moveFocus(s, 'left', lay(s)); // focus 0, sound 1
    const full = enterFullScreen(s, 0);
    expect(full).toMatchObject({ fullScreen: 0, focus: 0, sound: 0 });
    const back = exitFullScreen(full);
    expect(back).toMatchObject({ focus: 0, sound: 1 });
    expect(back.fullScreen).toBeUndefined();
  });
});

describe('idle chrome', () => {
  it('the first key while the chrome is hidden only wakes it', () => {
    const s = idle(two());
    const r = wake(s);
    expect(r.consumed).toBe(true);
    expect(r.state.chromeAwake).toBe(true);
    expect(r.state.focus).toBe(s.focus);
    expect(wake(r.state).consumed).toBe(false);
  });
});

describe('menuItems', () => {
  it('Full screen first, then Make large, Add channel, Change channel, sound, Close window', () => {
    const items = menuItems(two(), 0, { ok: true });
    expect(items.map((i) => i.id)).toEqual(['fullScreen', 'makeLarge', 'addChannel', 'changeChannel', 'keepSound', 'closeWindow']);
    expect(items.map((i) => i.label)).toEqual(['Full screen', 'Make large', 'Add channel', 'Change channel', 'Keep sound here', 'Close window']);
  });

  it('the Large window has no Make large; a pinned sound offers Sound follows focus', () => {
    const s = togglePin(makeLarge(two(), 0), 0);
    const ids = menuItems(s, 0, { ok: true }).map((i) => i.id);
    expect(ids).not.toContain('makeLarge');
    expect(ids).toContain('soundFollows');
  });

  it('Add channel stays visible with the reason when no window can be added', () => {
    const add = menuItems(two(), 0, { ok: false, reason: 'This device can play 2 at once.' }).find((i) => i.id === 'addChannel');
    expect(add).toEqual({ id: 'addChannel', label: 'Add channel', disabled: 'This device can play 2 at once.' });
  });
});

describe('soundToPlaying', () => {
  it('a failed window with sound hands it to a playing one, the focused one first', () => {
    const s = { ...addWindow(addWindow(start(w(0)), w(1)), w(2)), sound: 1, focus: 2 as const };
    expect(soundToPlaying(s, [true, false, true]).sound).toBe(2);
    expect(soundToPlaying({ ...s, focus: 1 }, [true, false, false]).sound).toBe(0);
  });

  it('nothing changes while the sound window plays, nothing else plays, or the sound is pinned', () => {
    const s = { ...two(), sound: 1 };
    expect(soundToPlaying(s, [true, true])).toBe(s);
    expect(soundToPlaying(s, [false, false])).toBe(s);
    const pinned = togglePin(two(), 1);
    expect(soundToPlaying(pinned, [true, false])).toBe(pinned);
  });
});

describe('5-6 windows (P2)', () => {
  const six = (): MvState => [1, 2, 3, 4, 5].reduce((s, n) => addWindow(s, w(n)), start(w(0)));

  it('Equal size from 4 to 6 windows, not with 3', () => {
    expect(equalSize(makeLarge(six(), 2)).equal).toBe(true);
    const three = makeLarge(addWindow(two(), w(2)), 1);
    expect(equalSize(three)).toBe(three);
    expect(menuItems(makeLarge(six(), 2), 0, { ok: true }).map((i) => i.id)).toContain('equalSize');
    expect(menuItems(six(), 0, { ok: true }).map((i) => i.id)).not.toContain('equalSize');
  });

  it('(f): from the Large window Right goes to the right column and Down to the small one under its left edge', () => {
    const s = { ...makeLarge(six(), 0), focus: 0 as const };
    const l = layout(layoutInput(s, 6));
    expect(moveFocus(s, 'right', l).focus).toBe(1);
    expect(moveFocus(s, 'down', l).focus).toBe(3);
  });

  it('(e): arrows walk the 3x2 grid', () => {
    const s = { ...six(), focus: 0 as const };
    const l = layout(layoutInput(s, 6));
    expect(moveFocus(s, 'right', l).focus).toBe(1);
    expect(moveFocus(s, 'down', l).focus).toBe(3);
    expect(moveFocus({ ...s, focus: 4 }, 'up', l).focus).toBe(1);
  });
});

describe('windows playing at once', () => {
  it('a window counts only after 10 s of steady play: 9 s does not, 10 s does', () => {
    const since = playingSince(new Map(), [{ n: 0, playing: true }, { n: 1, playing: true }], 0);
    const later = playingSince(since, [{ n: 0, playing: true }, { n: 1, playing: true }], 9_000);
    expect(steadyPlaying(later, 9_000)).toBe(0);
    expect(steadyPlaying(later, 10_000)).toBe(2);
  });

  it('a break in play starts the count again; a stopped window no longer counts', () => {
    let since = playingSince(new Map(), [{ n: 0, playing: true }, { n: 1, playing: true }], 0);
    since = playingSince(since, [{ n: 0, playing: true }, { n: 1, playing: false }], 5_000);
    since = playingSince(since, [{ n: 0, playing: true }, { n: 1, playing: true }], 6_000);
    expect(steadyPlaying(since, 15_000)).toBe(1);
    expect(steadyPlaying(since, 16_000)).toBe(2);
    since = playingSince(since, [{ n: 0, playing: true }], 17_000);
    expect(steadyPlaying(since, 17_000)).toBe(1);
  });
});

describe('Retry on a window the source cut (G9 decision C)', () => {
  it('offers "Watch this one instead" only when cut, another window plays, and the source is at its limit', () => {
    expect(retryAction({ cut: true, otherPlaying: true, atLimit: true })).toBe('watchInstead');
    expect(retryAction({ cut: false, otherPlaying: true, atLimit: true })).toBe('retry');
    expect(retryAction({ cut: true, otherPlaying: false, atLimit: true })).toBe('retry');
    expect(retryAction({ cut: true, otherPlaying: true, atLimit: false })).toBe('retry');
  });

  it('the source is at its limit when the other windows playing reach the reported or the learned limit', () => {
    expect(atSourceLimit({ reported: 1, othersPlaying: 1 })).toBe(true);
    expect(atSourceLimit({ reported: 2, othersPlaying: 1 })).toBe(false);
    // Learned: the source refused (or cut) window 2, so 1 fits.
    expect(atSourceLimit({ learnedRefusalAt: 2, othersPlaying: 1 })).toBe(true);
    expect(atSourceLimit({ learnedRefusalAt: 3, othersPlaying: 1 })).toBe(false);
    // Either one is enough: the lower of the two counts.
    expect(atSourceLimit({ reported: 4, learnedRefusalAt: 2, othersPlaying: 1 })).toBe(true);
    expect(atSourceLimit({ othersPlaying: 3 })).toBe(false);
  });

  it('the limit is the lower of the reported and learned ones, never below 1', () => {
    expect(sourceLimit({})).toBeUndefined();
    expect(sourceLimit({ reported: 3, learnedRefusalAt: 3 })).toBe(2);
    expect(sourceLimit({ reported: 0 })).toBe(1);
  });

  it('stops just enough of the other windows: one on a 1-connection source', () => {
    expect(windowsToStop(1, 1)).toBe(1);
    expect(windowsToStop(3, 2)).toBe(2);
    expect(windowsToStop(3, undefined)).toBe(1);
  });
});

describe('the picker info line (warns, never blocks)', () => {
  it('the reported count always shows when the source reports one (spec §4)', () => {
    expect(pickerHint({ reported: 1, open: 1 })).toEqual(['infoReported']);
    expect(pickerHint({ reported: 4, open: 1 })).toEqual(['infoReported']);
    expect(pickerHint({ reported: 4, learnedRefusalAt: 3, open: 1 })).toEqual(['infoReported']);
  });
  it('nothing known about the source: each window uses one connection', () => {
    expect(pickerHint({ open: 1 })).toEqual(['infoUnknown']);
  });
  it('a learned refusal at window 2 when adding window 2: shown in addition to the reported count', () => {
    expect(pickerHint({ learnedRefusalAt: 2, open: 1 })).toEqual(['learned']);
    expect(pickerHint({ reported: 4, learnedRefusalAt: 2, open: 1 })).toEqual(['infoReported', 'learned']);
  });
  it('nothing to say: no count reported and the learned refusal is beyond the next window', () => {
    expect(pickerHint({ learnedRefusalAt: 3, open: 1 })).toEqual([]);
  });
  it('while a connection is being freed, it says so first', () => {
    expect(pickerHint({ reported: 1, open: 1, freeing: true })).toEqual(['freeing', 'infoReported']);
  });
});

describe('Watch this one instead: the cancellable 5 s wait', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('opens the window only after 5 s, and says which window is waiting meanwhile', () => {
    const changes: Array<number | undefined> = [];
    const watch = createWatchInstead((slot) => { changes.push(slot); });
    const open = vi.fn();
    watch.start(1, open);
    expect(watch.pending()).toBe(1);
    vi.advanceTimersByTime(FREEING_MS - 1);
    expect(open).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(watch.pending()).toBeUndefined();
    expect(changes).toEqual([1, undefined]);
  });

  it('cancelled (left multiview, or the user acted on another window): nothing opens later', () => {
    const watch = createWatchInstead(() => undefined);
    const open = vi.fn();
    watch.start(1, open);
    vi.advanceTimersByTime(2_000);
    watch.cancel();
    expect(watch.pending()).toBeUndefined();
    vi.advanceTimersByTime(10_000);
    expect(open).not.toHaveBeenCalled();
  });

  it('a second start replaces the first: only the latest window opens', () => {
    const watch = createWatchInstead(() => undefined);
    const first = vi.fn();
    const second = vi.fn();
    watch.start(0, first);
    vi.advanceTimersByTime(1_000);
    watch.start(1, second);
    vi.advanceTimersByTime(FREEING_MS);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('Watch this one instead: a refused reopen gets exactly one more try after 10 s', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const opened = (watch: ReturnType<typeof createWatchInstead>, slot: number) => {
    vi.advanceTimersByTime(FREEING_MS);
    expect(watch.observe(slot, 'starting')).toBe('none');
  };

  it('the first refusal shows Freeing again and opens once more after 10 s; the second gives up for good', () => {
    const changes: Array<number | undefined> = [];
    const watch = createWatchInstead((slot) => { changes.push(slot); });
    const open = vi.fn();
    watch.start(1, open);
    opened(watch, 1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(watch.observe(1, 'refused')).toBe('again');
    expect(watch.pending()).toBe(1);
    vi.advanceTimersByTime(FREEING_RETRY_MS - 1);
    expect(open).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(open).toHaveBeenCalledTimes(2);
    expect(watch.pending()).toBeUndefined();
    expect(watch.observe(1, 'starting')).toBe('none');
    expect(watch.observe(1, 'refused')).toBe('gaveUp');
    vi.advanceTimersByTime(60_000);
    expect(open).toHaveBeenCalledTimes(2);
    expect(watch.observe(1, 'refused')).toBe('none');
    expect(changes).toEqual([1, undefined, 1, undefined]);
  });

  it('the old failure still showing before the reopen starts is not a refusal of the reopen', () => {
    const watch = createWatchInstead(() => undefined);
    watch.start(1, vi.fn());
    vi.advanceTimersByTime(FREEING_MS);
    expect(watch.observe(1, 'refused')).toBe('none');
    expect(watch.observe(1, 'starting')).toBe('none');
    expect(watch.observe(1, 'played')).toBe('played');
    expect(watch.observe(1, 'refused')).toBe('none');
  });

  it('a reopen that fails otherwise ends the watch: no more tries', () => {
    const watch = createWatchInstead(() => undefined);
    const open = vi.fn();
    watch.start(1, open);
    opened(watch, 1);
    expect(watch.observe(1, 'failed')).toBe('failed');
    vi.advanceTimersByTime(60_000);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('cancelled during the 10 s wait (left multiview, or acted on another window): nothing opens later', () => {
    const watch = createWatchInstead(() => undefined);
    const open = vi.fn();
    watch.start(1, open);
    opened(watch, 1);
    expect(watch.observe(1, 'refused')).toBe('again');
    vi.advanceTimersByTime(4_000);
    watch.cancel();
    expect(watch.pending()).toBeUndefined();
    vi.advanceTimersByTime(60_000);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('cancelled while the reopen is starting: its refusal gives up (no second try), and it is still reported', () => {
    const watch = createWatchInstead(() => undefined);
    const open = vi.fn();
    watch.start(1, open);
    opened(watch, 1);
    watch.cancel();
    expect(watch.observe(1, 'refused')).toBe('gaveUp');
    vi.advanceTimersByTime(60_000);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
