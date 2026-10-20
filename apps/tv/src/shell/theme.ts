/** Design tokens (UI revamp spec §1.1). Colours are Lightning `0xRRGGBBAA` numbers. */
export const COLORS = {
  background: 0x0b0d12ff,
  /** Cards without art, wide cards, guide cells. */
  surface: 0x151a24ff,
  /** Airing-now cells, unfocused buttons, the focused row's channel cell. */
  surfaceRaised: 0x1b2232ff,
  /** Progress tracks and the scroll track. */
  track: 0x232a38ff,
  /** The focus ring and focused fills: one focus style for the whole app. */
  focus: 0xeef0f4ff,
  /** Text and icons on a focus fill. */
  onFocus: 0x0b0d12ff,
  /** Only progress fills, the guide's now line and similar position marks. */
  accent: 0x4f8cffff,
  text: 0xeef0f4ff,
  /** Plots and descriptions. */
  textSecondary: 0xc9cdd6ff,
  /** Meta lines and channel numbers (≥ 7:1 on the background). */
  muted: 0xa3a9b8ff,
  /** Icons at rest, the time ruler (≥ 5:1 on the background). */
  subtle: 0x8a91a3ff,
  /** Semi-transparent background, for panels drawn over video. */
  panel: 0x0b0d12e6,
  /** Lighter see-through background for the full-screen info banner, so the picture shows through. */
  osd: 0x0b0d12a6,
  /** Dims whatever is underneath a dialog or the open rail. */
  scrim: 0x0b0d12a0,
  /** Validation and error text (always with words, never colour alone). */
  error: 0xff8a80ff,
  /** Pointer hover highlight (pointer mode only). */
  hover: 0x232b3cff,
} as const;

/** The background colour without alpha (0xRRGGBB), for the canvas fade textures (`vod/scrim.ts`). */
export const BACKGROUND_RGB = Math.floor(COLORS.background / 0x100);

/** The type scale. `meta` (24) is the smallest text anywhere. */
export const TYPE = {
  display: 48,
  title: 40,
  body: 26,
  meta: 24,
  /** Named exceptions. */
  detailTitle: 64,
  playerTitle: 44,
  numberEntry: 72,
} as const;

/** Legacy names, kept until phase 3 moves every screen to `TYPE`. `small` is now the 24 px minimum. */
export const FONT = { title: TYPE.display, heading: 32, body: TYPE.body, small: TYPE.meta } as const;

export const SPACE = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32, xxxl: 48 } as const;

/** 1920x1080 design space with a 5% overscan-safe margin; content starts right of the collapsed rail. */
export const LAYOUT = {
  width: 1920,
  height: 1080,
  safeX: 96,
  safeY: 54,
  /** Base spacing step. */
  gap: 24,
  radius: 10,
  /** The collapsed rail's width. */
  railW: 128,
  /** Content's left edge on screens with the rail. */
  contentX: 160,
  /** From contentX to the right safe edge (1824). */
  contentW: 1664,
} as const;

/** One focus style (spec §1.2): cards scale and get a light ring outside a dark gap; the rest get a fill only. */
export const FOCUS = { scale: 1.05, ring: 4, offset: 4, ms: 120 } as const;

/** How long focus must rest before the info strip and backdrop follow it. */
export const MOTION = { dwell: 250 } as const;

/**
 * Semibold text: spread on a <Text> (`<Text {...STRONG}>`). @lightningtv/solid's `fontWeight` renames the font
 * family (an SDF convention) and breaks the platform canvas font. The canvas renderer
 * (`core/text-rendering/CanvasTextRenderer.js`) writes `fontStyle` first in its CSS font string
 * ("<fontStyle> <size>px Unknown, <family>", e.g. "normal 600 26px Unknown, sans-serif"), so the weight rides there.
 * Checked in desktop Chrome (revamp phase 1, Task 1); if a TV draws tiny or fallback text, set this to `{}` and
 * hierarchy falls back to size and colour.
 */
export const STRONG = { fontStyle: 'normal 600' as 'normal' } as const;
