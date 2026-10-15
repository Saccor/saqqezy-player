/** Design tokens (Plan 2 global constraints). Colours are Lightning `0xRRGGBBAA` numbers. */
export const COLORS = {
  background: 0x0b0d12ff,
  surface: 0x151a24ff,
  focus: 0x4f8cffff,
  text: 0xe8eaf0ff,
  muted: 0x7d8496ff,
  /** Semi-transparent background, for panels drawn over video. */
  panel: 0x0b0d12e6,
  /** Dims whatever is underneath a dialog. */
  scrim: 0x0b0d12a0,
  /** Text on a focus-coloured fill. */
  onFocus: 0xffffffff,
  /** Validation messages (e.g. under the on-screen keyboard). */
  error: 0xff8a80ff,
  /** Pointer hover highlight (pointer mode only): a lighter surface, more subtle than focus. */
  hover: 0x232b3cff,
} as const;

export const FONT = { title: 48, heading: 32, body: 26, small: 22 } as const;

/** 1920x1080 design space with a 5% overscan-safe margin. */
export const LAYOUT = {
  width: 1920,
  height: 1080,
  safeX: 96,
  safeY: 54,
  /** Base spacing step. */
  gap: 24,
  radius: 12,
} as const;
