import { describe, expect, it } from 'vitest';
import { layout } from './layout.ts';
import {
  addWindow, click, closeWindow, enterFullScreen, exitFullScreen, focusRested, idle, layoutInput, makeLarge, menuItems,
  moveFocus, pointerFocus, soundToPlaying, start, togglePin, wake, type MvState,
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
