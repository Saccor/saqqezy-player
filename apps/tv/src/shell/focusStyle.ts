/** One focus look per kind (UI rethink spec 2026-10-26 §1.2). Pure: no Solid, no Lightning. */

/** In pointer mode the hovered item is drawn focused (on LG the pointer is focus); otherwise the key selection. */
export function drawnFocus(sel: number | undefined, hover: number | undefined, pointer: boolean): number | undefined {
  return pointer && hover !== undefined ? hover : sel;
}
