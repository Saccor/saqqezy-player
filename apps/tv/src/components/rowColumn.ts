import type { ElementNode } from '@lightningtv/solid';
import { createEffect, createMemo, createSignal, on } from 'solid-js';
import { stopMotion, tween } from '../shell/motion.ts';
import { MOTION } from '../shell/theme.ts';
import { columnHeight, rowShift, rowSlots, rowTops, type RowFrame } from './rowSlots.ts';

const sameNumbers = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The vertical row shift of a paged list of rows (Start, Movies, Series; motion research §4 #5). The rows sit at fixed
 * y's (`rowY`) in one column node (`ref`), placed inside a container whose top is at `clipTop`; moving the focused row
 * moves only the column: 220 ms on the standard curve, linear for the key gap while a key is held, snapped for a jump
 * of more than two rows or a new layout. `rows` lists the rows to mount: the `rowSlots` of the focused row plus, while
 * the column glides, the one row that is sliding out (so nothing pops).
 */
export function useRowColumn(opts: {
  heights: () => readonly number[];
  focusRow: () => number;
  frame: () => RowFrame;
  mode: () => 'peek' | 'whole';
  /** The y of the column's container on screen. */
  clipTop: number;
}) {
  let column: ElementNode | undefined;
  const [extra, setExtra] = createSignal<number | undefined>(undefined);
  const heights = createMemo(() => opts.heights(), undefined, { equals: sameNumbers });
  // A memo, so a column move (Left/Right) does not re-run the shift and cut a glide short.
  const focusRow = createMemo(() => Math.max(0, Math.min(opts.focusRow(), heights().length - 1)));
  const tops = createMemo(() => rowTops(heights(), opts.frame().gap), undefined, { equals: sameNumbers });
  const slots = createMemo(() => rowSlots(heights(), focusRow(), opts.frame(), opts.mode()));
  const rows = createMemo(() => {
    const out = slots().map((s) => s.index);
    const e = extra();
    if (e !== undefined && e < heights().length && !out.includes(e)) {
      if (e < (out[0] ?? 0)) out.unshift(e);
      else out.push(e);
    }
    return out;
  });
  createEffect(on([focusRow, tops] as const, ([row, t], prev) => {
    if (!column) return;
    const y = opts.frame().top - opts.clipTop - (t[row] ?? 0);
    // A new layout (other heights) snaps like the first one.
    const from = prev && prev[1] === t ? prev[0] : undefined;
    const plan = rowShift(heights(), from, row, opts.frame(), opts.mode());
    if (plan.snap) { setExtra(undefined); stopMotion(column); column.y = y; return; }
    setExtra(plan.extra);
    tween(column, { y }, MOTION.rowShift, () => setExtra(undefined));
  }));
  return {
    ref: (el: ElementNode) => { column = el; },
    /** The rows to mount, in order. */
    rows,
    /** A row's y in the column. */
    rowY: (i: number) => tops()[i] ?? 0,
    /** A row's height; set it on the row node, which otherwise takes the column's height less its y. */
    rowH: (i: number) => heights()[i] ?? 0,
    /** The column's height (all its rows); set it on the column node so the renderer never culls it while it slides. */
    height: () => columnHeight(heights(), opts.frame().gap),
  };
}
