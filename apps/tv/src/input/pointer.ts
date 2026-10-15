/**
 * Mouse and pointer-remote layer (spec: docs/superpowers/specs/2026-10-15-pointer-mouse-design.md), installed once in
 * `main.tsx` next to `installKeys`. Components opt in with `usePointerTarget`. Lightning's `useMouse` is not used: its
 * hover moves real focus, and the virtual lists have no per-row nodes.
 *
 * - `pointerMode()` is on while the pointer is in use. Pointer-only buttons and hover highlights show only then, so a
 *   remote user's screen stays exactly as before. Any logical remote key turns it off (`onLogicalKey`); characters
 *   typed into a field do not.
 * - Hit-testing reads the nodes' absolute rects at event time (never cached). Overlays beat the screen; within a
 *   layer the latest `usePointerTarget` call wins. Targets of a screen that is no longer on top are skipped.
 * - While an overlay target is shown, screen targets are not hit at all: a click outside every overlay target goes to
 *   the overlay's backdrop (`usePointerBackdrop`) when it has one, and is swallowed otherwise.
 * - Samsung Tizen has no pointer: nothing is installed there.
 */
import type { ElementNode } from '@lightningtv/solid';
import { createContext, createSignal, onCleanup, onMount, useContext } from 'solid-js';
import type { PlatformId } from '@iptv/platform';
import { router, type ScreenEntry } from '../shell/router.ts';
import { DESIGN_WIDTH } from '../video/videoLayer.ts';
import { onLogicalKey, sendKey } from './keys.ts';
import {
  POINTER_START, WHEEL_START, isClick, localPoint, nextClick, pickTarget, pointerModeReducer, toDesign, wheelPixels,
  wheelStep, type HitCandidate, type LastClick, type Point, type PointerModeEvent, type Press, type Rect,
} from './pointerLogic.ts';

export type { Point } from './pointerLogic.ts';

/** Only the error's name is logged: messages may carry URLs or other data. */
function errName(err: unknown): string | undefined {
  return (err as { name?: unknown } | null | undefined)?.name as string | undefined;
}

/** A click target. Points are design px relative to the node's top-left corner. */
export interface PointerTarget {
  /** The node whose absolute rect is the hit area. An accessor: refs are assigned after this registration. */
  node: () => ElementNode | undefined;
  /** 'overlay' (menus, keyboards, dialogs, the Player overlay) beats every 'screen' target. Default 'screen'. */
  layer?: 'screen' | 'overlay';
  /** Shell-owned (the shell's Back button): hit-tested on every screen. */
  global?: boolean;
  enabled?: () => boolean;
  /** Called on every move over the node; undefined on leave and when pointer mode turns off. */
  onHover?: (p: Point | undefined) => void;
  onClick?: (p: Point) => void;
  /** The second click of a double click. Without it, that click is an ordinary `onClick`. */
  onDoubleClick?: (p: Point) => void;
  /**
   * The part of the target under a node-local point (a list's row index, the guide's cell index). A double click
   * needs both clicks on the same part; without it the whole target is one part.
   */
  subAt?: (p: Point) => number | undefined;
  onContextMenu?: (p: Point) => void;
  /** One throttled wheel step per axis (-1, 0 or 1). True when handled; unhandled steps are dropped. */
  onWheel?: (dy: number, dx: number) => boolean;
}

interface Entry { seq: number; t: PointerTarget; scope: ScreenEntry | undefined }
type Down = Press & { scope: ScreenEntry | undefined; entry: Entry | undefined };

const TICK_MS = 250;
const NO_RECT: Rect = { x: 0, y: 0, w: 0, h: 0 };

const [mode, setMode] = createSignal(POINTER_START);

/** True while the mouse or pointer remote is in use. */
export const pointerMode = (): boolean => mode().on;

let nextSeq = 0;
let entries: Entry[] = [];
let hovered: Entry | undefined;
/** The last pointer position, design px. */
let lastPoint: Point | undefined;
let autoHide: (() => boolean) | undefined;
let applyCursor: (on: boolean) => void = () => undefined;

function safely(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error('Pointer handler failed', errName(err));
  }
}

function setHovered(entry: Entry | undefined, local: Point | undefined): void {
  const old = hovered;
  hovered = entry;
  if (old && old !== entry) safely(() => old.t.onHover?.(undefined));
  if (entry && local) safely(() => entry.t.onHover?.(local));
}

function dispatch(e: PointerModeEvent): void {
  const prev = mode();
  const next = pointerModeReducer(prev, e);
  if (next === prev) return;
  setMode(next);
  if (prev.on !== next.on) {
    applyCursor(next.on);
    if (!next.on) setHovered(undefined, undefined); // a remote key: no highlight stays behind
  }
}

function rectOf(n: ElementNode): Rect {
  const lng = n.lng as { absX?: number; absY?: number };
  return { x: lng.absX ?? 0, y: lng.absY ?? 0, w: n.width || 0, h: n.height || 0 };
}

/** Rendered, and neither the node nor an ancestor is fully transparent (Home's groups under the compact keyboard). */
function isShown(n: ElementNode): boolean {
  if (!n.rendered) return false;
  for (let p: ElementNode | undefined = n; p; p = p.parent) if (p.alpha === 0) return false;
  return true;
}

function hitAt(p: Point): { entry: Entry; local: Point } | undefined {
  const cur = router.current();
  const rects: Rect[] = [];
  const cands: HitCandidate[] = entries.map((e) => {
    const n = e.t.node();
    const rect = n ? rectOf(n) : NO_RECT;
    rects.push(rect);
    return {
      rect,
      overlay: e.t.layer === 'overlay',
      seq: e.seq,
      visible: n !== undefined && isShown(n),
      enabled: n !== undefined && (e.t.enabled?.() ?? true),
      inScope: e.t.global === true || e.scope === cur,
    };
  });
  const i = pickTarget(cands, p);
  const entry = i === undefined ? undefined : entries[i];
  const rect = i === undefined ? undefined : rects[i];
  return entry && rect ? { entry, local: localPoint(rect, p) } : undefined;
}

/** Re-reads the hover at the last position (after a click or a wheel step changed what is under it). */
function rehover(): void {
  if (!mode().on || !lastPoint) return;
  const h = hitAt(lastPoint);
  setHovered(h?.entry, h?.local);
}

/**
 * Registers a click target on mount and removes it on cleanup. The call order decides "latest wins". A target is
 * scoped to the screen on top when it mounts; shell-level overlays mounted outside any screen (such as the App-level
 * `ConfirmDialog`) must pass `global: true`, or they stop being hit (and stop being modal) when the screen changes.
 */
export function usePointerTarget(t: PointerTarget): void {
  const entry: Entry = { seq: ++nextSeq, t, scope: undefined };
  onMount(() => {
    entry.scope = router.current();
    entries = [...entries, entry];
  });
  onCleanup(() => {
    entries = entries.filter((e) => e !== entry);
    if (hovered === entry) hovered = undefined;
  });
}

/** The shell's layered Back, exactly like the remote's Back key (the top overlay first, then the screen). */
export function shellBack(): void {
  sendKey('Back');
}

/**
 * A full-screen click-outside target for an overlay. Call it before the overlay's own targets, so they win where they
 * overlap. A click or right click outside closes the overlay like Back; the wheel is swallowed. `enabled` false turns it
 * off (not modal) together with its overlay.
 */
export function usePointerBackdrop(node: () => ElementNode | undefined, onOutside: () => void = shellBack, global = false,
  enabled?: () => boolean): void {
  usePointerTarget({
    node, layer: 'overlay', global, enabled, onClick: () => onOutside(), onContextMenu: () => onOutside(), onWheel: () => true,
  });
}

/** A screen opts into the 3 s auto-hide (the Player); `fn` says whether it may hide now. Returns the remover. */
export function setPointerAutoHide(fn: () => boolean): () => void {
  autoHide = fn;
  return () => {
    if (autoHide === fn) autoHide = undefined;
  };
}

/** Lets an owner (Home, Settings) apply its own focus logic when a click focuses one of its nodes. */
export const PointerFocusContext = createContext<(node: ElementNode) => void>();

/** Focus for a click: the owner's logic when one is provided, else `node.setFocus()`. */
export function usePointerFocus(): (node: ElementNode | undefined) => void {
  const owner = useContext(PointerFocusContext);
  return (node) => {
    if (!node) return;
    if (owner) owner(node);
    else node.setFocus();
  };
}

/**
 * Installs the DOM listeners: pointer moves, clicks, right clicks, the wheel, the mouse back button, the webOS
 * `cursorStateChange` event and the auto-hide tick. The CSS cursor is `default` in pointer mode and `none` otherwise.
 * Returns an uninstall function.
 */
export function installPointer(opts: { canvas: HTMLCanvasElement; platform: PlatformId; target?: Window }): () => void {
  if (opts.platform === 'tizen') return () => undefined;
  const win = opts.target ?? window;
  const { canvas } = opts;
  applyCursor = (on) => {
    const c = on ? 'default' : 'none';
    canvas.style.cursor = c;
    win.document.body.style.cursor = c;
  };
  applyCursor(mode().on);

  const design = (e: { clientX: number; clientY: number }): Point => {
    const r = canvas.getBoundingClientRect();
    return toDesign(e.clientX, e.clientY, r, r.width > 0 ? r.width / DESIGN_WIDTH : 1);
  };
  let down: Down | undefined;
  let lastClick: LastClick | undefined;
  let wheel = WHEEL_START;

  const onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    lastPoint = design(e);
    dispatch({ type: 'move', x: e.clientX, y: e.clientY, at: Date.now() });
    rehover();
  };
  const onDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    if (e.button === 3 || e.button === 4) {
      e.preventDefault(); // never browser history navigation
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;
    lastPoint = design(e);
    dispatch({ type: 'move', x: e.clientX, y: e.clientY, at: Date.now() });
    if (e.button !== 0) return; // a right click only wakes pointer mode; its action runs on contextmenu
    down = { x: e.clientX, y: e.clientY, at: Date.now(), scope: router.current(), entry: hitAt(lastPoint)?.entry };
  };
  const onUp = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    if (e.button === 3) {
      e.preventDefault();
      shellBack();
      return;
    }
    if (e.button === 4) {
      e.preventDefault();
      return;
    }
    if (e.button !== 0 || !down) return;
    const start = down;
    down = undefined;
    const at = Date.now();
    // A drag, a long press, or a press that started on another screen is not a click.
    if (!isClick(start, { x: e.clientX, y: e.clientY, at }) || router.current() !== start.scope) return;
    const h = hitAt(design(e));
    if (!h || h.entry !== start.entry) return;
    const t = h.entry.t;
    let sub: number | undefined;
    safely(() => { sub = t.subAt?.(h.local); });
    const c = nextClick(lastClick, at, h.entry.seq, sub);
    lastClick = c.last;
    const double = c.double;
    safely(() => {
      if (double && t.onDoubleClick) t.onDoubleClick(h.local);
      else t.onClick?.(h.local);
    });
    queueMicrotask(rehover);
  };
  const onContext = (e: MouseEvent) => {
    e.preventDefault();
    // The keyboard Menu key and Shift+F10 fire contextmenu too: only a real right-button press in pointer mode counts.
    if (e.button !== 2 || (e as PointerEvent).pointerType === 'touch' || !mode().on) return;
    const h = hitAt(design(e));
    if (h) safely(() => h.entry.t.onContextMenu?.(h.local));
    queueMicrotask(rehover);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    let dy = wheelPixels(e.deltaY, e.deltaMode);
    let dx = wheelPixels(e.deltaX, e.deltaMode);
    if (e.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    const r = wheelStep(wheel, dy, dx, Date.now());
    wheel = r.state;
    if (r.dy === 0 && r.dx === 0) return;
    const h = hitAt(design(e));
    if (h) safely(() => { h.entry.t.onWheel?.(r.dy, r.dx); });
    queueMicrotask(rehover);
  };
  const onLeave = (e: MouseEvent) => {
    if (e.relatedTarget !== null) return; // still inside the page
    lastPoint = undefined;
    setHovered(undefined, undefined);
  };
  /** Mouse back and forward buttons: Chromium and WebView2 may navigate history on mouseup or auxclick. */
  const onHistoryButton = (e: MouseEvent) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  };
  const onCursor = (e: Event) => {
    const v = (e as CustomEvent<{ visibility?: boolean } | undefined>).detail?.visibility;
    if (v === true) dispatch({ type: 'cursorShown', at: Date.now() });
    else if (v === false) dispatch({ type: 'cursorHidden' });
  };

  const offKeys = onLogicalKey(() => dispatch({ type: 'key' }));
  const tick = setInterval(() => {
    if (mode().on) dispatch({ type: 'tick', now: Date.now(), autoHide: autoHide?.() ?? false });
  }, TICK_MS);
  win.addEventListener('pointermove', onMove);
  win.addEventListener('pointerdown', onDown);
  win.addEventListener('pointerup', onUp);
  win.addEventListener('contextmenu', onContext);
  win.addEventListener('mouseup', onHistoryButton);
  win.addEventListener('auxclick', onHistoryButton);
  win.addEventListener('wheel', onWheel, { passive: false });
  win.document.addEventListener('mouseout', onLeave);
  win.document.addEventListener('cursorStateChange', onCursor);
  return () => {
    offKeys();
    clearInterval(tick);
    win.removeEventListener('pointermove', onMove);
    win.removeEventListener('pointerdown', onDown);
    win.removeEventListener('pointerup', onUp);
    win.removeEventListener('contextmenu', onContext);
    win.removeEventListener('mouseup', onHistoryButton);
    win.removeEventListener('auxclick', onHistoryButton);
    win.removeEventListener('wheel', onWheel);
    win.document.removeEventListener('mouseout', onLeave);
    win.document.removeEventListener('cursorStateChange', onCursor);
    setHovered(undefined, undefined);
    lastPoint = undefined;
    setMode(POINTER_START);
    canvas.style.cursor = '';
    win.document.body.style.cursor = '';
    applyCursor = () => undefined;
  };
}
