import type { ScreenChange, ScreenId } from './router.ts';
import { EASE, MOTION, type MotionToken } from './theme.ts';

/**
 * Pure motion rules (motion research §3 and §5); the Lightning side is `shell/motion.ts`.
 *
 * - `full`: tokens as they are. `reduced`: movement (x, y, scale) snaps, fades stay but at most 150 ms. `off`: all snaps.
 * - The cadence follows the user's pace: normal (first press, or a gap of 250 ms or more), brisk (120 to 250 ms: focus
 *   and scroll at 0.6) or repeat (under 120 ms, a held key: the focus scale and image fades snap, a row scroll glides
 *   linearly for the key gap so steps join and never fall behind).
 */
export type MotionLevel = 'full' | 'reduced' | 'off';
export type Cadence = 'normal' | 'brisk' | 'repeat';
/** What an animated property is: movement (x, y, scale) or a fade (alpha). */
export type PropClass = 'move' | 'fade';

export const MOTION_LEVELS: readonly MotionLevel[] = ['full', 'reduced', 'off'];

export interface MotionContext {
  level: MotionLevel;
  cadence: Cadence;
  /** The last gap between navigation keydowns (ms), if there were two. */
  gap: number | undefined;
  /** Animations running now. */
  live: number;
}

/** A planned animation: `ms` 0 means snap (assign the value at once). */
export interface MotionPlan { ms: number; ease: string }

export function classifyGap(gap: number | undefined): Cadence {
  if (gap === undefined || gap >= MOTION.briskGap) return 'normal';
  return gap < MOTION.repeatGap ? 'repeat' : 'brisk';
}

const NAV_KEYS = new Set(['Up', 'Down', 'Left', 'Right', 'ChannelUp', 'ChannelDown']);

/** The keys whose pace motion follows (OK and the rest do not move focus through a list). */
export function isNavKey(key: string): boolean {
  return NAV_KEYS.has(key);
}

/** Tracks navigation keydowns: their pace, and whether a key is being held. Times in ms (any monotonic clock). */
export class KeyCadence {
  private last: number | undefined;
  private lastGap: number | undefined;
  private released = true;

  down(now: number): void {
    this.lastGap = this.last === undefined ? undefined : now - this.last;
    this.last = now;
    this.released = false;
  }

  up(): void {
    this.released = true;
  }

  gap(): number | undefined {
    return this.lastGap;
  }

  current(now: number): Cadence {
    if (this.last === undefined || this.released || now - this.last >= MOTION.settle) return 'normal';
    return classifyGap(this.lastGap);
  }

  /** A navigation key is held (keys arrive faster than 120 ms apart and none was released). */
  held(now: number): boolean {
    return this.current(now) === 'repeat';
  }
}

/** The duration and easing for one property of one animation, or `ms` 0 to snap. */
export function planMotion(token: MotionToken, prop: PropClass, c: MotionContext): MotionPlan {
  const snap: MotionPlan = { ms: 0, ease: token.ease };
  if (c.level === 'off' || c.live >= MOTION.maxLive) return snap;
  let ms = token.ms;
  let ease = token.ease;
  if (c.cadence === 'repeat') {
    if (token.kind === 'focus' || token.kind === 'image') return snap;
    if (token.kind === 'scroll') {
      ms = Math.min(ms, c.gap ?? ms);
      ease = EASE.glide;
    }
  } else if (c.cadence === 'brisk' && (token.kind === 'focus' || token.kind === 'scroll')) {
    ms = Math.round(ms * MOTION.briskFactor);
  }
  if (c.level === 'reduced') {
    if (prop === 'move') return snap;
    ms = Math.min(ms, MOTION.reducedFadeMax);
  }
  return { ms, ease };
}

/** The session's level: auto-lite (`lite`, low frame rate measured) lowers Full to Reduced; a user's Reduced or Off stays. */
export function sessionLevel(level: MotionLevel, lite: boolean): MotionLevel {
  return lite && level === 'full' ? 'reduced' : level;
}

/**
 * Auto-lite (motion research §5 rule 2): samples frame intervals only while animations run (`start` when the first
 * starts, `stop` when the last ends; the first frame of a run only sets the clock, so idle time never counts). Once
 * `windowMs` of animated time is sampled, a median interval longer than 1000 / `minFps` ms drops the session for good
 * (`dropped`; never back up, no flapping); otherwise a new window starts.
 */
export class AutoLite {
  private samples: number[] = [];
  private total = 0;
  private last: number | undefined;
  private running = false;
  dropped = false;

  constructor(private readonly windowMs: number = MOTION.liteWindow, private readonly minFps: number = MOTION.liteFps) {}

  start(): void {
    this.running = !this.dropped;
    this.last = undefined;
  }

  stop(): void {
    this.running = false;
    this.last = undefined;
  }

  /** A frame at `t` (ms). True when this frame dropped the session. */
  frame(t: number): boolean {
    if (!this.running) return false;
    const prev = this.last;
    this.last = t;
    if (prev === undefined) return false;
    const dt = t - prev;
    this.samples.push(dt);
    this.total += dt;
    if (this.total < this.windowMs) return false;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    this.samples = [];
    this.total = 0;
    if (median <= 1000 / this.minFps) return false;
    this.dropped = true;
    this.running = false;
    return true;
  }
}

/** While the Player or VodPlay is up, decoding owns the CPU and GPU: motion is reduced at most. */
export function effectiveLevel(level: MotionLevel, playing: boolean): MotionLevel {
  return playing && level === 'full' ? 'reduced' : level;
}

/** The Motion setting's next value: Full, Reduced, Off, then Full again. */
export function nextMotionLevel(level: MotionLevel): MotionLevel {
  return MOTION_LEVELS[(MOTION_LEVELS.indexOf(level) + 1) % MOTION_LEVELS.length]!;
}

/** The stored setting when it is a level, else the system's reduced-motion preference. */
export function parseMotionLevel(stored: unknown, prefersReduced: boolean): MotionLevel {
  if (typeof stored === 'string' && (MOTION_LEVELS as readonly string[]).includes(stored)) return stored as MotionLevel;
  return prefersReduced ? 'reduced' : 'full';
}

/** Screens that show video: they appear at once (the picture must not fade, and decoding owns the GPU). */
const VIDEO_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>(['player', 'vodPlay', 'home']);

/**
 * Whether a screen reached by `change` fades in (motion research §4 #9): only going forward (a push or a replace),
 * never to a video screen, on cold start (a reset) or on Back. `railStays`: both screens draw the rail (a rail tab,
 * Search, Settings), so nothing fades: the whole screen fading would blink the rail that stays in place.
 */
export function screenEnters(change: ScreenChange | undefined, screen: ScreenId, railStays = false): boolean {
  return (change === 'push' || change === 'replace') && !VIDEO_SCREENS.has(screen) && !railStays;
}
