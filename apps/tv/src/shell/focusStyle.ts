/** One focus look per kind (UI rethink spec 2026-10-26 §1.2). Pure: no Solid, no Lightning. */

/** In pointer mode the hovered item is drawn focused (on LG the pointer is focus); otherwise the key selection. */
export function drawnFocus(sel: number | undefined, hover: number | undefined, pointer: boolean): number | undefined {
  return pointer && hover !== undefined ? hover : sel;
}

/**
 * Where the drawn focus comes from in pointer mode. The hovered row wins only after the pointer actually moved; a wheel
 * step hands the drawn focus back to the key selection, and the `rehover()` the pointer layer runs after it (same
 * position, possibly a different row because the list scrolled) must not take it away again.
 */
export interface FocusSource {
  hover: number | undefined;
  at: { x: number; y: number } | undefined;
  hoverWins: boolean;
}
export const focusInit = (): FocusSource => ({ hover: undefined, at: undefined, hoverWins: false });

/** A hover report: `index` is the selectable row under `at` (undefined: none), `at` undefined when the pointer left. */
export function hoverEvent(s: FocusSource, index: number | undefined, at: { x: number; y: number } | undefined): FocusSource {
  const moved = at !== undefined && (s.at === undefined || s.at.x !== at.x || s.at.y !== at.y);
  return { hover: index, at, hoverWins: s.hoverWins || moved };
}

/** A wheel step moved the selection: draw it. */
export const wheelFocus = (s: FocusSource): FocusSource => ({ ...s, hoverWins: false });

export const drawnRow = (sel: number | undefined, s: FocusSource, pointer: boolean): number | undefined =>
  drawnFocus(sel, s.hoverWins ? s.hover : undefined, pointer);
