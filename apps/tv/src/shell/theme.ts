/** Design tokens 2.0 (UI rethink spec 2026-10-26 §1.1). Colours are Lightning `0xRRGGBBAA` numbers. */
export const COLORS = {
  background: 0x0b0d12ff,
  /** Cards without art, wide cards, guide cells. */
  surface: 0x151a24ff,
  /** Airing-now cells, unfocused buttons. */
  surfaceRaised: 0x1b2232ff,
  /** Every progress track, on any background (the bar tokens merged, spec §1.1). */
  track: 0x232a38ff,
  /**
   * How far a VOD has loaded, drawn over `track` on the Timeline (owner decision in plan review: the buffered bar stays).
   * A lighter step of `track`: 1.45:1 against it, and `accent` stays dominant at 3.08:1 over it.
   */
  trackBuffered: 0x3a4356ff,
  /** The focus ring and focused fills; pointer hover is drawn the same (spec §1.2). */
  focus: 0xeef0f4ff,
  /** Text and icons on a focus fill. */
  onFocus: 0x0b0d12ff,
  /** Secondary text on a focus fill, and a progress track on a focus fill. */
  onFocusMuted: 0x4a505cff,
  /** Only progress fills, the guide's now line and the selected ✓. */
  accent: 0x4f8cffff,
  text: 0xeef0f4ff,
  /** Plots and descriptions. */
  textSecondary: 0xc9cdd6ff,
  /** Meta lines and channel numbers (≥ 7:1 on the background). */
  muted: 0xa3a9b8ff,
  /** Icons at rest, the time ruler, badge outlines (≥ 5:1 on the background). */
  subtle: 0x8a91a3ff,
  /** Semi-transparent background for anything drawn over video (sheets, notices, the subtitle outline). */
  panel: 0x0b0d12e6,
  /** Dims whatever is underneath a sheet or dialog. */
  scrim: 0x0b0d12a0,
  /** Validation and error text (always with words, never colour alone). */
  error: 0xff8a80ff,
  /** Fully transparent, for fills that are only drawn while focused. */
  transparent: 0x00000000,
} as const;

/** Calm, dark title-card colours (white text stays readable on each). */
export const TITLE_CARD_COLOURS: readonly number[] = [
  0x1d3b53ff, 0x3a1f2bff, 0x16302bff, 0x2a2440ff, 0x40311aff, 0x13263dff, 0x2f3a1cff, 0x33202fff,
];

/** The background colour without alpha (0xRRGGBB), for the canvas fade textures (`vod/scrim.ts`). */
export const BACKGROUND_RGB = Math.floor(COLORS.background / 0x100);

/** Four text sizes plus the numeral (spec §1.1). `meta` (24) is the smallest text anywhere. */
export const TYPE = {
  meta: 24,
  body: 28,
  /** Screen and section titles, the player title. */
  title: 40,
  /** Detail title only. */
  hero: 64,
  /** Number entry only. */
  numeral: 72,
} as const;

/** Line heights for wrapped text, per size. */
export const LINE = { meta: 32, body: 36, title: 48 } as const;

/** Every layout gap (spec §1.1): 4, 12 and 32 are dropped. */
export const SPACE = { s: 8, m: 16, l: 24, xl: 48 } as const;

/** 12 for cards, cells and rows; a pill is half its height. */
export const RADIUS = { card: 12, pill: (h: number): number => h / 2 } as const;

/** The one alpha a resting element may take (a dimmed button). */
export const ALPHA = { dimmed: 0.5 } as const;

/** The badge outline (spec §1.3 Badge: "one small outlined label"). */
export const STROKE = { outline: 2 } as const;

/** 1920x1080 design space with a 5% overscan-safe margin; content starts right of the collapsed rail. */
export const LAYOUT = {
  width: 1920,
  height: 1080,
  safeX: 96,
  safeY: 54,
  /** Base spacing step (SPACE.l). */
  gap: SPACE.l,
  /** The collapsed rail's width. */
  railW: 128,
  /** Content's left edge on screens with the rail. */
  contentX: 160,
  /** From contentX to the right safe edge (1824). */
  contentW: 1664,
} as const;

/** The renderer draws a text line a few px below its y; centred text lifts by this much. */
const TEXT_NUDGE = 4;
/** The y of a one-line text of `size` centred in a box `boxH` tall. */
export const centerText = (boxH: number, size: number): number => (boxH - size) / 2 - TEXT_NUDGE;

/** Focus (spec §1.2): tiles scale and get a 4 px ring at 4 px offset; rows, buttons, tabs and cells get a fill only. */
export const FOCUS = { scale: 1.05, ring: 4, offset: 4, /** The focused card's scale while OK is held. */ press: 1.02 } as const;

/**
 * Easing curves (motion research §3), always as explicit `cubic-bezier(...)` strings: renderer 3.7's named
 * `'ease-out-sine'` maps to the ease-in curve. No overshoot anywhere.
 */
export const EASE = {
  /** On-screen moves: focus scale, row scroll. */
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  /** Things arriving: menus, toasts. */
  enter: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  /** Things leaving. */
  exit: 'cubic-bezier(0.3, 0, 0.8, 0.15)',
  /** Cross-fades: backdrop, images. */
  fade: 'cubic-bezier(0.33, 0, 0.67, 1)',
  /** Held keys: consecutive scroll steps join into one constant-speed glide. */
  glide: 'linear',
} as const;

/**
 * What a motion token follows (see `shell/motionLogic.ts`): `focus` and `scroll` follow the key cadence (shortened when
 * keys come fast, snapped or glided while a key is held); `image` fades skip while a key is held; `ui` (menus, toasts,
 * cross-fades) ignores the cadence.
 */
export type MotionKind = 'focus' | 'scroll' | 'image' | 'ui';
export interface MotionToken { readonly ms: number; readonly ease: string; readonly kind: MotionKind }

const token = (ms: number, ease: string, kind: MotionKind): MotionToken => ({ ms, ease, kind });

/** Motion tokens (motion research §3) plus the dwell: how long focus must rest before the info strip and backdrop follow it. */
export const MOTION = {
  dwell: 250,
  /** Every auto-hide (toasts and info notices, the live banner, the VOD controls). Spec §1.1. */
  autoHide: 4000,
  /** Card focus scale up and down: leaving is quicker than arriving. */
  focusIn: token(120, EASE.standard, 'focus'),
  focusOut: token(90, EASE.standard, 'focus'),
  /** OK press dip of the focused card (to FOCUS.press on keydown, back on release). */
  pressIn: token(60, EASE.standard, 'ui'),
  pressOut: token(100, EASE.standard, 'ui'),
  /** A row's horizontal scroll (one strip moves). */
  rowScroll: token(180, EASE.standard, 'scroll'),
  /** A page of rows shifting up or down a row (one column moves). */
  rowShift: token(220, EASE.standard, 'scroll'),
  /** A poster image fading in over its skeleton or title card once loaded. */
  imageIn: token(160, EASE.fade, 'image'),
  /** The info strip's new title and meta fading in once the dwell settles (no fade-out: it would add delay). */
  textIn: token(140, EASE.enter, 'ui'),
  /** A screen pushed (not Back, not video screens, not cold start): fade plus a rise of `screenRise` px. */
  screenIn: token(200, EASE.enter, 'ui'),
  screenRise: 12,
  /** The rail opening (its panel slides out, the scrim and labels fade in) and closing. Focus moves at once. */
  railOpen: token(160, EASE.standard, 'ui'),
  railClose: token(120, EASE.standard, 'ui'),
  /** The backdrop cross-fade. */
  backdrop: token(260, EASE.fade, 'ui'),
  /** Menus and dialogs opening: fade plus a rise of `rise` px. They close at once (unmount). */
  menuIn: token(160, EASE.enter, 'ui'),
  toastIn: token(180, EASE.enter, 'ui'),
  /** The wordmark fading in or out. */
  wordmark: token(200, EASE.fade, 'ui'),
  /** How far menus and toasts rise as they open. */
  rise: 16,
  /** A fade's starting alpha: above 0, because the renderer does not load the texture of an alpha 0 node. */
  startAlpha: 0.001,
  /** An image that loads within this long of its mount is a cache hit: it shows at once, with no fade. */
  cacheHit: 50,
  /** Key cadence: gaps between navigation keydowns below `repeatGap` are a held key, below `briskGap` brisk. */
  repeatGap: 120,
  briskGap: 250,
  /** Brisk navigation runs its focus and scroll motion at this fraction of the token. */
  briskFactor: 0.6,
  /** No navigation key for this long (or a keyup) and the cadence is normal again. */
  settle: 250,
  /** Reduced motion keeps fades, capped at this long. */
  reducedFadeMax: 150,
  /** Live animations at once; beyond this, new ones snap (1 GB TVs). */
  maxLive: 8,
  /** Auto-lite: below `liteFps` (median) over `liteWindow` ms of running animation, the session drops to Reduced. */
  liteFps: 45,
  liteWindow: 2000,
} as const;

/**
 * Semibold text: spread on a <Text> (`<Text {...STRONG}>`). @lightningtv/solid's `fontWeight` renames the font
 * family (an SDF convention) and breaks the platform canvas font. The canvas renderer
 * (`core/text-rendering/CanvasTextRenderer.js`) writes `fontStyle` first in its CSS font string
 * ("<fontStyle> <size>px Unknown, <family>", e.g. "normal 600 26px Unknown, sans-serif"), so the weight rides there.
 * Checked in desktop Chrome (revamp phase 1, Task 1); if a TV draws tiny or fallback text, set this to `{}` and
 * hierarchy falls back to size and colour.
 */
export const STRONG = { fontStyle: 'normal 600' as 'normal' } as const;
