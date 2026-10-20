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
  /** Secondary text on a focus fill. */
  onFocusMuted: 0x4a505cff,
  /** The unfilled part of a progress bar on a focus fill. */
  onFocusTrack: 0xc5c9d2ff,
  /** Only progress fills, the guide's now line and similar position marks. */
  accent: 0x4f8cffff,
  /**
   * The chip in effect at rest (ActionBar `current`): a deeper accent, so `text` on it is ≥ 4.5:1 and the chip is
   * ≥ 3:1 against the background and the resting chips beside it. A focused chip keeps the focus fill.
   */
  selected: 0x3568d0ff,
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
  /** Fully transparent, for fills that are only drawn while focused or hovered. */
  transparent: 0x00000000,
  /** The buffered range on the movie timeline. */
  buffered: 0xffffff4d,
  /** The pending seek range ahead of the playhead on the timeline. */
  scrubAhead: 0x4f8cff66,
  /** The pending seek range behind the playhead on the timeline. */
  scrubBack: 0xffffff80,
  /** The outline behind subtitle text drawn over video. */
  subtitleOutline: 0x000000e6,
  /** A progress track drawn on artwork, where `track` would not read. */
  imageTrack: 0x000000aa,
} as const;

/** Calm, dark title-card colours (white text stays readable on each). */
export const TITLE_CARD_COLOURS: readonly number[] = [
  0x1d3b53ff, 0x3a1f2bff, 0x16302bff, 0x2a2440ff, 0x40311aff, 0x13263dff, 0x2f3a1cff, 0x33202fff,
];

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
