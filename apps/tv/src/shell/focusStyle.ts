import { COLORS } from './theme.ts';

/** One focus look per kind (UI rethink spec 2026-10-26 §1.2). Pure: no Solid, no Lightning. */

/**
 * Hover merges into focus: a genuine pointer move onto a selectable row selects it, so the drawn row, OK, Up/Down and
 * the wheel all act on the same row. `rehover()` after a wheel step re-reports the same position, which is not a move.
 */
export interface HoverTrack { at: { x: number; y: number } | undefined }
export const hoverInit = (): HoverTrack => ({ at: undefined });

/** A hover report: `index` is the selectable row under `at` (undefined: none), `at` undefined when the pointer left. */
export function hoverMove(s: HoverTrack, index: number | undefined, at: { x: number; y: number } | undefined): { focus: HoverTrack; select: number | undefined } {
  const moved = at !== undefined && (s.at === undefined || s.at.x !== at.x || s.at.y !== at.y);
  return { focus: { at }, select: moved ? index : undefined };
}

/** A control (row, button, tab, cell) is lit when focused, or hovered in pointer mode: one hover style, equal to focus. */
export const isLit = (focused: boolean, hovered: boolean, pointer: boolean): boolean => focused || (pointer && hovered);
export const controlFill = (lit: boolean, rest: number = COLORS.transparent): number => (lit ? COLORS.focus : rest);
export const controlText = (lit: boolean): number => (lit ? COLORS.onFocus : COLORS.text);
export const controlSubText = (lit: boolean): number => (lit ? COLORS.onFocusMuted : COLORS.muted);
/** Selected but not focused: a ✓ and nothing else. */
export const SELECTED_MARK = '✓';
export const selectedInk = (lit: boolean): number => (lit ? COLORS.onFocus : COLORS.accent);
