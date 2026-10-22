import { MULTIVIEW_COPY } from '../../copy.ts';
import type { Layout, LayoutInput, Rect } from './layout.ts';

/**
 * Multiview state, pure (spec 2026-10-20-multiview §2; owner decisions §12 and 2026-10-22). Windows are kept in the
 * order they were added; each plays in its own playback slot. Exactly one window has the sound: it follows the focus
 * after the focus has rested `SOUND_REST_MS` (D-pad or mouse hover), at once on a click, and stays put while pinned.
 * The screen turns the state into rects (`layout`), mute flags and the pool's primary slot.
 */
export interface MvWindow {
  /** The playback slot it plays in (the pool index). */
  slot: number;
  channelId: string;
}

export interface MvState {
  /** In the order they were added. */
  windows: MvWindow[];
  /** The window marked Large (index into `windows`). */
  large?: number;
  /** "Equal size" (4 windows in 2x2 even with one marked Large). */
  equal: boolean;
  /** The focused window, or the empty "Add channel" slot. */
  focus: number | 'empty';
  /** The window with sound. */
  sound: number;
  /** "Keep sound here": the sound stays on `sound` while the focus moves. */
  pinned: boolean;
  /** The window shown full screen; Back returns to the layout. */
  fullScreen?: number;
  /** Focus and sound before full screen, restored by Back. */
  beforeFullScreen?: { focus: number | 'empty'; sound: number };
  /** Labels, ring and the empty slot are shown; they fade after `CHROME_IDLE_MS` without input. */
  chromeAwake: boolean;
}

export const SOUND_REST_MS = 400;
export const CHROME_IDLE_MS = 4000;

export type MenuId = 'fullScreen' | 'makeLarge' | 'equalSize' | 'addChannel' | 'changeChannel' | 'keepSound' | 'soundFollows' | 'closeWindow';
export interface MenuItem { id: MenuId; label: string; disabled?: string }

export function start(first: MvWindow): MvState {
  return { windows: [first], equal: false, focus: 0, sound: 0, pinned: false, chromeAwake: true };
}

/** A new window takes the focus; the sound follows once the focus rests there. */
export function addWindow(s: MvState, w: MvWindow): MvState {
  return { ...s, windows: [...s.windows, w], focus: s.windows.length, chromeAwake: true };
}

/**
 * Closes window `i`. One window left: multiview ends with it (it plays on full screen, no reconnect). Otherwise focus
 * and sound go to the window now at the closed one's place (or the last), and a closed Large window hands Large to the
 * next one when 3 or more remain.
 */
export function closeWindow(s: MvState, i: number): MvState | { leave: MvWindow } {
  const windows = s.windows.filter((_, k) => k !== i);
  if (windows.length <= 1) return { leave: windows[0] ?? s.windows[i]! };
  const shift = (k: number) => (k > i ? k - 1 : k);
  const focus = Math.min(i, windows.length - 1);
  const next: MvState = { ...s, windows, focus, sound: s.sound === i ? focus : shift(s.sound), chromeAwake: true };
  if (s.sound === i) next.pinned = false;
  if (s.large === i) {
    if (windows.length >= 3) next.large = Math.min(i, windows.length - 1);
    else delete next.large;
  } else if (s.large !== undefined) next.large = shift(s.large);
  if (windows.length < 4) next.equal = false;
  delete next.fullScreen;
  delete next.beforeFullScreen;
  return next;
}

export function makeLarge(s: MvState, i: number): MvState {
  return { ...s, large: i, equal: false };
}

/** "Equal size": 4 windows in 2x2, 5-6 in the 3x2 grid (with fewer, nothing is marked Large for long). */
export function equalSize(s: MvState): MvState {
  return s.windows.length >= 4 ? { ...s, equal: true } : s;
}

/** The rect of the focused window or of the empty slot in `l`. */
function focusRect(s: MvState, l: Layout): Rect | undefined {
  if (s.focus === 'empty') return l.empty?.rect;
  return l.tiles.find((t) => t.tile === s.focus)?.rect;
}

/**
 * Moves the focus by geometry: Left and Right within a row, Up and Down to the nearest row, preferring the window
 * under (or over) the current one's left edge. The empty "Add channel" slot can take the focus.
 */
export function moveFocus(s: MvState, dir: 'left' | 'right' | 'up' | 'down', l: Layout): MvState {
  const from = focusRect(s, l);
  if (!from) return s;
  const targets: Array<{ id: number | 'empty'; r: Rect }> = l.tiles.map((t) => ({ id: t.tile, r: t.rect }));
  if (l.empty) targets.push({ id: 'empty', r: l.empty.rect });
  const overlapsY = (r: Rect) => r.y < from.y + from.h && from.y < r.y + r.h;
  let best: { id: number | 'empty'; score: number } | undefined;
  for (const t of targets) {
    if (t.id === s.focus) continue;
    const r = t.r;
    let score: number | undefined;
    if (dir === 'left' && overlapsY(r) && r.x + r.w <= from.x) score = from.x - (r.x + r.w);
    else if (dir === 'right' && overlapsY(r) && r.x >= from.x + from.w) score = r.x - (from.x + from.w);
    else if ((dir === 'down' && r.y >= from.y + from.h) || (dir === 'up' && r.y + r.h <= from.y)) {
      const gap = dir === 'down' ? r.y - (from.y + from.h) : from.y - (r.y + r.h);
      // Under the left edge first, then the nearest by x.
      const under = from.x >= r.x && from.x < r.x + r.w ? 0 : Math.min(Math.abs(r.x - from.x), Math.abs(r.x + r.w - from.x));
      score = gap * 10_000 + under;
    }
    if (score !== undefined && (!best || score < best.score)) best = { id: t.id, score };
  }
  return best ? { ...s, focus: best.id, chromeAwake: true } : s;
}

/** The focus rested `SOUND_REST_MS` on a window: the sound moves there unless pinned. */
export function focusRested(s: MvState): MvState {
  if (s.pinned || s.focus === 'empty' || s.focus === s.sound) return s;
  return { ...s, sound: s.focus };
}

/**
 * The window with sound failed (refused, unavailable): the sound goes to a window that has not failed (`ok[i]`: playing
 * or starting), the focused one first, so the screen never falls silent over a message. A pinned sound stays.
 */
export function soundToPlaying(s: MvState, ok: readonly boolean[]): MvState {
  if (s.pinned || ok[s.sound] !== false) return s;
  const to = typeof s.focus === 'number' && ok[s.focus] ? s.focus : ok.findIndex((p) => p);
  return to < 0 || to === s.sound ? s : { ...s, sound: to };
}

/** Mouse hover (desktop): focus now; the sound follows after the rest, as for the D-pad (owner 2026-10-22). */
export function pointerFocus(s: MvState, i: number): MvState {
  return s.focus === i ? { ...s, chromeAwake: true } : { ...s, focus: i, chromeAwake: true };
}

/** A click: focus and sound at once (unless pinned elsewhere). */
export function click(s: MvState, i: number): MvState {
  return { ...s, focus: i, sound: s.pinned ? s.sound : i, chromeAwake: true };
}

/** "Keep sound here" on window `i`, or "Sound follows focus" when already pinned (the sound goes to the focus). */
export function togglePin(s: MvState, i: number): MvState {
  if (s.pinned) return { ...s, pinned: false, sound: s.focus === 'empty' ? s.sound : s.focus };
  return { ...s, pinned: true, sound: i };
}

export function enterFullScreen(s: MvState, i: number): MvState {
  return { ...s, fullScreen: i, beforeFullScreen: { focus: s.focus, sound: s.sound }, focus: i, sound: i };
}

/** Back from full screen: the layout with the focus and sound from before. */
export function exitFullScreen(s: MvState): MvState {
  const before = s.beforeFullScreen ?? { focus: s.focus, sound: s.sound };
  const next: MvState = { ...s, focus: before.focus, sound: before.sound, chromeAwake: true };
  delete next.fullScreen;
  delete next.beforeFullScreen;
  return next;
}

export function idle(s: MvState): MvState {
  return { ...s, chromeAwake: false };
}

/** A key arrived: while the chrome is hidden it only wakes it (a stray press never moves the focus or the sound). */
export function wake(s: MvState): { state: MvState; consumed: boolean } {
  return s.chromeAwake ? { state: s, consumed: false } : { state: { ...s, chromeAwake: true }, consumed: true };
}

/** The window menu (spec §2.4, owner §12.5): Full screen first; Add channel shows its reason when it cannot. */
export function menuItems(s: MvState, i: number, canAdd: { ok: true } | { ok: false; reason: string }): MenuItem[] {
  const items: MenuItem[] = [{ id: 'fullScreen', label: MULTIVIEW_COPY.fullScreen }];
  if (s.large !== i || s.equal) items.push({ id: 'makeLarge', label: MULTIVIEW_COPY.makeLarge });
  if (s.windows.length >= 4 && s.large !== undefined && !s.equal) items.push({ id: 'equalSize', label: MULTIVIEW_COPY.equalSize });
  const add: MenuItem = { id: 'addChannel', label: MULTIVIEW_COPY.addChannel };
  if (!canAdd.ok) add.disabled = canAdd.reason;
  items.push(add, { id: 'changeChannel', label: MULTIVIEW_COPY.changeChannel });
  items.push(s.pinned ? { id: 'soundFollows', label: MULTIVIEW_COPY.soundFollows } : { id: 'keepSound', label: MULTIVIEW_COPY.keepSound });
  items.push({ id: 'closeWindow', label: MULTIVIEW_COPY.closeWindow });
  return items;
}

export function layoutInput(s: MvState, windowLimit: number): LayoutInput {
  const i: LayoutInput = { tiles: s.windows.length, equal: s.equal, windowLimit };
  if (s.large !== undefined) i.large = s.large;
  return i;
}
