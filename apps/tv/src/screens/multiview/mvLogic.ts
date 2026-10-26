import { MULTIVIEW_COPY } from '../../copy.ts';
import type { WindowNote } from '../../playback/windowNotes.ts';
import { MOTION } from '../../shell/theme.ts';
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
export const CHROME_IDLE_MS = MOTION.autoHide;

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

/**
 * "Most windows playing at once" counts a window only after this much play without a break (G9 decision C), so one
 * that opened and failed at once is not counted. A later cut verdict corrects any overcount (`capSeen`).
 */
export const STEADY_PLAY_MS = 10_000;

/**
 * When each slot's current run of play began: kept while it plays, set at `now` when it starts, dropped on any break
 * (buffering, a failure, a stop) or when the slot is gone.
 */
export function playingSince(prev: ReadonlyMap<number, number>, slots: ReadonlyArray<{ n: number; playing: boolean }>, now: number): Map<number, number> {
  const next = new Map<number, number>();
  for (const s of slots) if (s.playing) next.set(s.n, prev.get(s.n) ?? now);
  return next;
}

/** The windows that have played steadily for `STEADY_PLAY_MS` at `now`. */
export function steadyPlaying(since: ReadonlyMap<number, number>, now: number): number {
  let n = 0;
  for (const at of since.values()) if (now - at >= STEADY_PLAY_MS) n++;
  return n;
}

/**
 * The streams the source lets play at once, as far as the app knows: the reported count, or one less than the window
 * it refused or cut (`learnedRefusalAt`), whichever is lower. Undefined when neither is known.
 */
export function sourceLimit(f: { reported?: number; learnedRefusalAt?: number }): number | undefined {
  const limits = [f.reported, f.learnedRefusalAt === undefined ? undefined : f.learnedRefusalAt - 1].filter((n): n is number => n !== undefined);
  return limits.length > 0 ? Math.max(1, Math.min(...limits)) : undefined;
}

/** The source's limit is reached when the other windows playing fill it. No limit known: never. */
export function atSourceLimit(f: { reported?: number; learnedRefusalAt?: number; othersPlaying: number }): boolean {
  const limit = sourceLimit(f);
  return limit !== undefined && f.othersPlaying >= limit;
}

/** "Watch this one instead": how many of the other windows playing must stop so this one fits (at least one). */
export function windowsToStop(othersPlaying: number, limit: number | undefined): number {
  return Math.min(othersPlaying, Math.max(1, othersPlaying - (limit ?? othersPlaying) + 1));
}

/**
 * Retry on a window (G9 decision C). The source cut it while another window plays and the source is at its limit:
 * a plain Retry would only cut the other window again, so it offers "Watch this one instead".
 */
export function retryAction(f: { cut: boolean; otherPlaying: boolean; atLimit: boolean }): 'retry' | 'watchInstead' {
  return f.cut && f.otherPlaying && f.atLimit ? 'watchInstead' : 'retry';
}

/**
 * The picker's info lines, as `MULTIVIEW_COPY` keys in order (owner decision 12.2: it warns, never blocks). `open` is
 * the windows open besides the one being picked. A connection being freed comes first, then the one limit line (each
 * window uses one connection), so the line is never empty.
 */
export function pickerHint(f: { open: number; freeing?: boolean }): Array<'freeing' | 'limit'> {
  const lines: Array<'freeing' | 'limit'> = [];
  if (f.freeing) lines.push('freeing');
  lines.push('limit');
  return lines;
}

/** "Watch this one instead" waits this long after stopping the other window, so the source frees its connection (§5.3). */
export const FREEING_MS = 5000;
/**
 * The reopen was refused all the same (a panel can free a connection late; the fake panel keeps an HLS session for
 * 20 s): one more try this much later, and never another by itself.
 */
export const FREEING_RETRY_MS = 20_000;

/** What a reopening window's stream did, as the screen reads its status. */
export type ReopenStatus = 'starting' | 'played' | 'refused' | 'failed' | 'other';

/** A window's playback status, as much as these mappings read of it. */
export interface WindowStatus { kind: string; reason?: string }

/** A window's status for the watch: loading or reconnecting is a reopen starting; a refusal is told from other failures. */
export function reopenStatus(st: WindowStatus | undefined): ReopenStatus {
  if (st?.kind === 'loading' || st?.kind === 'reconnecting') return 'starting';
  if (st?.kind === 'playing') return 'played';
  if (st?.kind === 'failed') return st.reason === 'refused' ? 'refused' : 'failed';
  return 'other';
}

/** The source cut or refused the window (not the TV, not an escalation): its note says so, else its refused status. */
export function wasCut(note: WindowNote | undefined, st: WindowStatus | undefined): boolean {
  if (note) return note.kicked !== undefined || note.pingPong === true;
  return st?.kind === 'failed' && st.reason === 'refused';
}

export interface WatchInstead {
  /** Waits `FREEING_MS`, then calls `open`. A later start replaces this one. */
  start(slot: number, open: () => void): void;
  /**
   * Feeds the status of `slot`. Only a reopen this watch made, and only once it started, counts (the old failure still
   * showing does not). `again`: refused the first time, it waits `FREEING_RETRY_MS` (the window shows "Freeing…") and
   * opens once more. `gaveUp`: refused the second time, or after a cancel: the window shows its failure as usual.
   * `played` / `failed`: the watch is over. `none`: not one of its reopens, or nothing to say yet. `token` is the raw
   * status: a failure other than the one showing when the reopen was issued counts as started (a batched status change
   * may never show 'starting').
   */
  observe(slot: number, status: ReopenStatus, token?: unknown): 'again' | 'gaveUp' | 'played' | 'failed' | 'none';
  /** No wait opens anything later (multiview left, or the user acted on a window meanwhile). */
  cancel(): void;
  /** Window `slot` plays something else or closed: its reopen is no longer watched (a later refusal is its own). */
  forget(slot: number): void;
  /** The slot waiting to open, if any. */
  pending(): number | undefined;
}

/**
 * The wait behind "Watch this one instead"; `onChange` hears the waiting slot (the window shows "Freeing a
 * connection…"). `tokenOf` reads a slot's raw status, kept when a reopen is issued (see `observe`).
 */
export function createWatchInstead(onChange: (slot: number | undefined) => void, tokenOf?: (slot: number) => unknown): WatchInstead {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let slot: number | undefined;
  /** Reopens in flight: whether each has started, whether it is the last try, how to open it again, the status before. */
  const reopens = new Map<number, { started: boolean; last: boolean; open: () => void; before: unknown }>();
  const set = (s: number | undefined) => {
    if (s === slot) return;
    slot = s;
    onChange(s);
  };
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const wait = (s: number, ms: number, last: boolean, open: () => void) => {
    clear();
    set(s);
    timer = setTimeout(() => {
      timer = undefined;
      set(undefined);
      reopens.set(s, { started: false, last, open, before: tokenOf?.(s) });
      open();
    }, ms);
  };
  return {
    start(s, open) {
      reopens.delete(s);
      wait(s, FREEING_MS, false, open);
    },
    observe(s, status, token) {
      const r = reopens.get(s);
      if (!r) return 'none';
      if (status === 'starting') {
        r.started = true;
        return 'none';
      }
      if (status === 'other') return 'none';
      // A failure that is not the one showing when the reopen was issued is the reopen's, 'starting' seen or not.
      if (!r.started && (token === undefined || token === r.before)) return 'none';
      reopens.delete(s);
      if (status === 'played') return 'played';
      if (status === 'failed') return 'failed';
      if (r.last) return 'gaveUp';
      wait(s, FREEING_RETRY_MS, true, r.open);
      return 'again';
    },
    cancel() {
      clear();
      set(undefined);
      // A reopen already on its way is still watched (its refusal stays on the window), but never tried again.
      for (const r of reopens.values()) r.last = true;
    },
    forget(s) { reopens.delete(s); },
    pending: () => slot,
  };
}
