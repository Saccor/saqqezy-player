import { detectPlatform, keyTableFor, mapKey, type KeyTable, type LogicalKey } from '@iptv/platform';
import type { KeyMap } from '@lightningtv/solid';

/** Only the error's name is logged: messages may carry URLs or other data. */
function errName(err: unknown): string | undefined {
  return (err as { name?: unknown } | null | undefined)?.name as string | undefined;
}

/** Logical keys as seen by the UI: the remote keys plus the synthesised long-press of Ok. */
export type UiKey = LogicalKey | 'LongOk';

export const LONG_PRESS_MS = 600;

const LOGICAL_KEYS: UiKey[] = [
  'Up', 'Down', 'Left', 'Right', 'Ok', 'LongOk', 'Back', 'Menu', 'Info', 'ChannelUp', 'ChannelDown',
  'PlayPause', 'Play', 'Pause', 'Stop', 'FastForward', 'Rewind', 'VolumeUp', 'VolumeDown', 'Mute',
  'Red', 'Green', 'Yellow', 'Blue',
  'Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
];

/**
 * Key map for Lightning's `useFocusManager`. Raw device keys never reach Lightning: `installKeys` forwards
 * a synthetic event whose `key` is the logical name, so Lightning handlers are `on<Logical>` (`onUp`,
 * `onBack`, `onLongOk`, `onDigit5`, ...) except Ok, which stays Lightning's conventional `onEnter`.
 */
export const LIGHTNING_KEY_MAP: Partial<KeyMap> = Object.fromEntries(
  LOGICAL_KEYS.map((k) => [k === 'Ok' ? 'Enter' : k, k]),
);

/** Text-entry targets keep their keys (typing, caret, Back/Delete): the remote mapping must not touch them. */
function isTextEntry(t: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(t instanceof HTMLElement)) return false;
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable;
}

type Listener = (key: UiKey, e: KeyboardEvent) => void;
const listeners = new Set<Listener>();

/** Global logical-key handler (called for every logical key, after Lightning's focus path). */
export function onLogicalKey(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const rawListeners = new Set<(e: KeyboardEvent) => void>();

/**
 * Observer for keydowns that map to no logical key (e.g. F12 for the debug overlay in the browser). The event
 * is not prevented, so browser defaults still apply.
 */
export function onUnmappedKey(fn: (e: KeyboardEvent) => void): () => void {
  rawListeners.add(fn);
  return () => { rawListeners.delete(fn); };
}

const gestureListeners = new Set<() => void>();

/**
 * Observer for every real keydown (mapped or not, typed or not) and every mouse press and release, called while the
 * browser still counts it as a user gesture. The player uses it to give the sound back after an autoplay-policy mute
 * (only when the input really activated the page; see `AutoMute.releaseOnGesture`).
 */
export function onUserGesture(fn: () => void): () => void {
  gestureListeners.add(fn);
  return () => { gestureListeners.delete(fn); };
}

/** Tells the `onUserGesture` observers about a user gesture: a real keydown, or a pointer press or release. */
export function notifyUserGesture(): void {
  for (const fn of [...gestureListeners]) {
    try {
      fn();
    } catch (err) {
      console.error('Gesture handler failed', errName(err));
    }
  }
}

let textCapture: ((e: KeyboardEvent) => boolean) | undefined;

/**
 * While a text field is being edited (on-screen keyboard open), `fn` sees every raw keydown first. When it
 * returns true the key was typed into the field: it is prevented and not mapped to a logical key (so
 * `m`, `i`, digits and Backspace type instead of acting as Menu, Info, Digit or Back), and its keyup is
 * swallowed too. Keys it declines (arrows, Enter, Escape, colour keys) stay remote keys. Only one capture is
 * active at a time; the returned function releases it.
 */
export function captureTextInput(fn: (e: KeyboardEvent) => boolean): () => void {
  textCapture = fn;
  return () => { if (textCapture === fn) textCapture = undefined; };
}

let inject: ((key: UiKey) => void) | undefined;

/**
 * Sends a logical key through Lightning's focus path exactly as the remote would (keydown, then keyup). It does not
 * notify `onLogicalKey` subscribers, so the pointer layer that sends it (the mouse Back) stays in pointer mode. A no-op
 * until `installKeys` runs.
 */
export function sendKey(key: UiKey): void {
  inject?.(key);
}

/**
 * Installs the one global key listener: maps device keys through `@iptv/platform`, forwards them to
 * Lightning's focus system as logical keys and notifies `onLogicalKey` subscribers.
 *
 * Ok is decided on release: released before 600 ms it is `Ok`; held 600 ms it becomes `LongOk` (and no
 * `Ok` follows). Returns an uninstall function.
 */
export function installKeys(
  target: Window = window,
  table: KeyTable = keyTableFor(detectPlatform(navigator.userAgent, target as unknown as { tizen?: unknown; webOS?: unknown; __IPTV_HOST__?: unknown })),
): () => void {
  const forwarded = new WeakSet<Event>();
  /** Keys typed into a field whose keyup must not reach the remote mapping either. */
  const typed = new Set<string>();
  let okTimer: ReturnType<typeof setTimeout> | undefined;
  let okLong = false;

  const forward = (type: 'keydown' | 'keyup', key: UiKey, src: KeyboardEvent) => {
    const ev = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, repeat: src.repeat });
    forwarded.add(ev);
    target.document.dispatchEvent(ev);
  };
  const notify = (key: UiKey, e: KeyboardEvent) => {
    for (const fn of [...listeners]) {
      try {
        fn(key, e);
      } catch (err) {
        console.error('Key handler failed', errName(err));
      }
    }
  };
  const press = (key: UiKey, e: KeyboardEvent) => {
    forward('keydown', key, e);
    notify(key, e);
  };
  const injectKey = (key: UiKey) => {
    const src = new KeyboardEvent('keydown', { key });
    forward('keydown', key, src);
    forward('keyup', key, src);
  };
  inject = injectKey;

  const onKeyDown = (e: KeyboardEvent) => {
    if (forwarded.has(e)) return;
    notifyUserGesture();
    if (isTextEntry(e.target)) return;
    e.stopImmediatePropagation();
    let consumed = false;
    try {
      consumed = textCapture?.(e) === true;
    } catch (err) {
      console.error('Text input handler failed', errName(err));
    }
    if (consumed) {
      e.preventDefault();
      typed.add(e.code || e.key);
      return;
    }
    const key = mapKey(table, e);
    if (!key) {
      for (const fn of [...rawListeners]) {
        try {
          fn(e);
        } catch (err) {
          console.error('Key handler failed', errName(err));
        }
      }
      return;
    }
    e.preventDefault();
    if (key === 'Ok') {
      // Remotes repeat keydown while held, not always with `repeat` set: the running timer is the guard.
      if (okTimer !== undefined || okLong) return;
      okTimer = setTimeout(() => {
        okTimer = undefined;
        okLong = true;
        press('LongOk', e);
        forward('keyup', 'LongOk', e);
      }, LONG_PRESS_MS);
      return;
    }
    press(key, e);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (forwarded.has(e) || isTextEntry(e.target)) return;
    e.stopImmediatePropagation();
    if (typed.delete(e.code || e.key)) {
      e.preventDefault();
      return;
    }
    const key = mapKey(table, e);
    if (!key) return;
    e.preventDefault();
    if (key === 'Ok') {
      if (okTimer !== undefined) {
        clearTimeout(okTimer);
        okTimer = undefined;
        press('Ok', e);
        forward('keyup', 'Ok', e);
      }
      okLong = false;
      return;
    }
    forward('keyup', key, e);
  };

  const onBlur = () => {
    typed.clear();
    if (okTimer !== undefined) clearTimeout(okTimer);
    okTimer = undefined;
    okLong = false;
  };

  // Capture on window runs before Lightning's own document listeners, so raw events never reach them.
  target.addEventListener('keydown', onKeyDown, true);
  target.addEventListener('keyup', onKeyUp, true);
  target.addEventListener('blur', onBlur);
  return () => {
    onBlur();
    if (inject === injectKey) inject = undefined;
    target.removeEventListener('keydown', onKeyDown, true);
    target.removeEventListener('keyup', onKeyUp, true);
    target.removeEventListener('blur', onBlur);
  };
}
