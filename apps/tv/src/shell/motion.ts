import type { ElementNode } from '@lightningtv/solid';
import { createEffect, createMemo, createSignal, on } from 'solid-js';
import { TOAST_OVERLAY_ID } from './logic.ts';
import { router } from './router.ts';
import { FOCUS, MOTION, type MotionToken } from './theme.ts';
import { effectiveLevel, KeyCadence, parseMotionLevel, planMotion, type MotionLevel, type PropClass } from './motionLogic.ts';

/**
 * The one way the TV app animates (motion research §4 #1). The `transition` prop is broken on our stack (renderer 3.7 has
 * no `animateProp`), so everything goes through `node.animate()`, with these rules:
 *
 * - One owner per node and property: a new target stops the running animation with `stop(false)` (no reset) and starts
 *   from the current, mid-flight value. Never queued. Do not also bind that property as a Solid prop.
 * - Input is never delayed: nothing here is awaited on a key path; state changes at once and motion follows.
 * - Durations follow the key cadence and the motion level (`planMotion`), and at most `MOTION.maxLive` animations run;
 *   beyond that, and for nodes not rendered yet, the value is assigned at once.
 * - Controllers are pooled by the renderer: a reference is dropped as soon as its animation stops, so a stale one is
 *   never stopped (it may already drive another node).
 */

export type AnimProp = 'x' | 'y' | 'alpha' | 'scale';

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

const [level, setLevel] = createSignal<MotionLevel>(parseMotionLevel(undefined, prefersReducedMotion()));

/** The user's motion level (Settings › Display › Motion; default from `prefers-reduced-motion`). */
export const motionLevel = level;

/** Applies a stored Motion setting (`undefined`: follow the system preference). */
export function setMotionLevel(stored: unknown): void {
  setLevel(parseMotionLevel(stored, prefersReducedMotion()));
}

const PLAYBACK_SCREENS = new Set(['player', 'vodPlay']);

/** The level in force now: reduced at most while video plays. */
function levelNow(): MotionLevel {
  const screen = router.current()?.screen;
  return effectiveLevel(level(), screen !== undefined && PLAYBACK_SCREENS.has(screen));
}

const cadence = new KeyCadence();

/** Called by the key layer (`input/keys.ts`) on every navigation keydown, before focus moves. */
export function noteNavKeyDown(t: number = now()): void {
  cadence.down(t);
}

/** Called by the key layer on a navigation keyup. */
export function noteNavKeyUp(): void {
  cadence.up();
}

/** A navigation key is being held (keys arrive under 120 ms apart): skip decorative work such as image fades. */
export function navKeyHeld(): boolean {
  return cadence.held(now());
}

const [okDown, setOkDown] = createSignal(false);

/**
 * Called by the key layer when OK goes down (its long-press timer starts) and when it is released or becomes LongOk.
 * Only feedback: the Ok or LongOk action still fires exactly as before.
 */
export function noteOkPress(down: boolean): void {
  setOkDown(down);
}

/** OK is held on the screen itself (not in a menu or dialog above it; a toast does not take OK). */
const okOnScreen = (): boolean => {
  if (!okDown()) return false;
  const top = router.topOverlay();
  return top === undefined || top === TOAST_OVERLAY_ID;
};

interface Controller {
  start(): unknown;
  stop(reset?: boolean): unknown;
  on(event: 'stopped', fn: () => void): void;
}

interface Owned { ctl: Controller; interrupted: boolean }

const owners = new WeakMap<ElementNode, Map<AnimProp, Owned>>();
let live = 0;

/** Animations running now (debug and tests). */
export function liveAnimations(): number {
  return live;
}

function animateProp(node: ElementNode, prop: AnimProp, value: number, token: MotionToken, onDone?: () => void): void {
  let props = owners.get(node);
  const prev = props?.get(prop);
  if (prev) {
    props!.delete(prop);
    prev.interrupted = true;
    prev.ctl.stop(false);
  }
  const cls: PropClass = prop === 'alpha' ? 'fade' : 'move';
  const t = now();
  const plan = planMotion(token, cls, { level: levelNow(), cadence: cadence.current(t), gap: cadence.gap(), live });
  if (plan.ms <= 0 || !node.rendered || node[prop] === value) {
    node[prop] = value;
    onDone?.();
    return;
  }
  const ctl = node.animate({ [prop]: value }, { duration: plan.ms, easing: plan.ease }) as unknown as Controller;
  const owned: Owned = { ctl, interrupted: false };
  if (!props) { props = new Map(); owners.set(node, props); }
  props.set(prop, owned);
  live++;
  ctl.on('stopped', () => {
    live--;
    const map = owners.get(node);
    if (map?.get(prop) === owned) map.delete(prop);
    if (!owned.interrupted) onDone?.();
  });
  ctl.start();
}

/**
 * Animates `props` of `node` to their values with `token` (one animation per property; `alpha` counts as a fade, the
 * rest as movement). `onDone` runs once every property has reached its target, also when snapped; not when a newer
 * target interrupted it.
 */
export function tween(node: ElementNode, props: Partial<Record<AnimProp, number>>, token: MotionToken, onDone?: () => void): void {
  const keys = (Object.keys(props) as AnimProp[]).filter((k) => props[k] !== undefined);
  let left = keys.length;
  const done = onDone ? () => { if (--left === 0) onDone(); } : undefined;
  if (left === 0) { onDone?.(); return; }
  for (const k of keys) animateProp(node, k, props[k]!, token, done);
}

/** Stops `node`'s animations where they are (no reset) and forgets them: for a node about to be reused or removed. */
export function stopMotion(node: ElementNode): void {
  const props = owners.get(node);
  if (!props) return;
  owners.delete(node);
  for (const o of props.values()) { o.interrupted = true; o.ctl.stop(false); }
}

/**
 * A card's focus scale: up to `FOCUS.scale` in 120 ms when it gains focus (`lit`), back to 1 in 90 ms when it loses it,
 * snapped while a key is held. The card's node must not bind `scale` itself. The focus ring, a child of the node, scales
 * with it. A card mounted already lit starts at its scale (no animation). While OK is held on the focused card it dips
 * to `FOCUS.press` (60 ms) and comes back on release or LongOk (100 ms).
 */
export function useFocusScale(node: () => ElementNode | undefined, lit: () => boolean): void {
  // Only the lit card follows OK, so a press does not re-run every card's effect.
  const pressed = createMemo(() => lit() && okOnScreen());
  createEffect(on([lit, pressed] as const, ([l, p], prev) => {
    const n = node();
    if (!n) return;
    const target = !l ? 1 : p ? FOCUS.press : FOCUS.scale;
    if (prev === undefined) { n.scale = target; return; }
    const token = l !== prev[0] ? (l ? MOTION.focusIn : MOTION.focusOut) : p ? MOTION.pressIn : MOTION.pressOut;
    tween(n, { scale: target }, token);
  }));
}

/** The clock motion uses (ms, monotonic). */
export const motionNow = now;

/**
 * Shows an image node mounted at `MOTION.startAlpha` once its texture has loaded: a 160 ms fade, or at once when it
 * loaded within `MOTION.cacheHit` ms of `mountedAt` (a cache hit) or while a navigation key is held.
 */
export function fadeInLoaded(node: ElementNode, mountedAt: number): void {
  if (now() - mountedAt < MOTION.cacheHit || navKeyHeld()) {
    stopMotion(node);
    node.alpha = 1;
    return;
  }
  tween(node, { alpha: 1 }, MOTION.imageIn);
}

/**
 * Opens a menu, dialog or toast: from `MOTION.startAlpha` and `MOTION.rise` px lower to its place, with `token`. Call it
 * from the overlay's outermost `ref` (whose `alpha` and `y` no Solid prop changes later). Focus is not affected: the
 * overlay takes it at once, while it is still fading in. It closes by unmounting, at once.
 */
export function riseIn(node: ElementNode, token: MotionToken = MOTION.menuIn): void {
  queueMicrotask(() => {
    const y = node.y ?? 0;
    if (levelNow() === 'off') return;
    node.alpha = MOTION.startAlpha;
    if (levelNow() === 'full') node.y = y + MOTION.rise;
    tween(node, { alpha: 1, y }, token);
  });
}
