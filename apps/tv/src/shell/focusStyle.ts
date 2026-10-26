/** One focus look per kind (UI rethink spec 2026-10-26 §1.2). Pure: no Solid, no Lightning. */

/** In pointer mode the hovered item is drawn focused (on LG the pointer is focus); otherwise the key selection. */
export function drawnFocus(sel: number | undefined, hover: number | undefined, pointer: boolean): number | undefined {
  return pointer && hover !== undefined ? hover : sel;
}

/**
 * Hover merges into focus: a genuine pointer move onto a selectable row selects it, so the drawn row, OK, Up/Down and
 * the wheel all act on the same row. `rehover()` after a wheel step re-reports the same position, which is not a move.
 */
export interface FocusSource { at: { x: number; y: number } | undefined }
export const focusInit = (): FocusSource => ({ at: undefined });

/** A hover report: `index` is the selectable row under `at` (undefined: none), `at` undefined when the pointer left. */
export function hoverMove(s: FocusSource, index: number | undefined, at: { x: number; y: number } | undefined): { focus: FocusSource; select: number | undefined } {
  const moved = at !== undefined && (s.at === undefined || s.at.x !== at.x || s.at.y !== at.y);
  return { focus: { at }, select: moved ? index : undefined };
}
