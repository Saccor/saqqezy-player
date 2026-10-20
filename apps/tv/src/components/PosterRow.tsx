import { For, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal } from 'solid-js';
import type { VodTile } from '@iptv/app-api';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { ROW_VISIBLE_COLS, cellAt, cellCount, drawnCells, type Cell, type RowModel } from '../vod/browseLogic.ts';
import { POSTER_GAP, POSTER_H, POSTER_W, PosterTile } from './PosterTile.tsx';
import { renderRange, scrollTopFor } from './virtualWindow.ts';

const PITCH = POSTER_W + POSTER_GAP;
const tileOf = (c: Cell): VodTile | undefined => (c.kind === 'tile' ? c.tile : undefined);
/** View all is a text tile; a loading cell is drawn as a skeleton (no tile, no label). */
const labelOf = (c: Cell): string | undefined => (c.kind === 'viewAll' ? 'View all' : undefined);
/** Tiles kept rendered beyond each edge of the visible ones. */
const BUFFER = 3;

/**
 * One horizontally virtualised poster row (not focusable: the screen owns the keys). The focused column stays in view,
 * moving the row as little as possible. Pointer: click or right click on a tile reports its column.
 */
export function PosterRow(props: {
  x: number; y: number; width: number;
  row: RowModel;
  focusCol: number | undefined;
  lit: boolean;
  onCellClick?: (col: number) => void;
  onCellOptions?: (col: number) => void;
  /** A wheel step over the row (this target wins over the screen's, so the screen's handler is passed down). */
  onWheel?: (dy: number, dx: number) => boolean;
}) {
  const [hover, setHover] = createSignal<number | undefined>(undefined);
  let node: ElementNode | undefined;
  let lastScroll = 0;
  const cells = () => cellCount(props.row);
  const scroll = createMemo(() => {
    if (props.focusCol !== undefined) lastScroll = scrollTopFor(props.focusCol, lastScroll, ROW_VISIBLE_COLS, cells());
    else lastScroll = Math.min(lastScroll, Math.max(0, cells() - ROW_VISIBLE_COLS));
    return lastScroll;
  });
  const cols = createMemo(() => {
    const r = renderRange(scroll(), ROW_VISIBLE_COLS, drawnCells(props.row), BUFFER);
    return Array.from({ length: r.to - r.from }, (_, i) => r.from + i);
  });
  const colAt = (px: number) => {
    const c = scroll() + Math.floor(px / PITCH);
    return px % PITCH < POSTER_W && c < cells() ? c : undefined;
  };
  usePointerTarget({
    node: () => node,
    onHover: (p) => setHover(p ? colAt(p.x) : undefined),
    subAt: (p) => colAt(p.x),
    onClick: (p) => { const c = colAt(p.x); if (c !== undefined) props.onCellClick?.(c); },
    onContextMenu: (p) => { const c = colAt(p.x); if (c !== undefined) props.onCellOptions?.(c); },
    onWheel: (dy, dx) => props.onWheel?.(dy, dx) ?? false,
  });
  return (
    <View ref={(el) => { node = el; }} x={props.x} y={props.y} width={props.width} height={POSTER_H}>
      <For each={cols()}>{(c) => {
        const cell = () => cellAt(props.row, c);
        return (
          <PosterTile x={(c - scroll()) * PITCH} y={0} w={POSTER_W} h={POSTER_H}
            tile={tileOf(cell())} label={labelOf(cell())}
            lit={props.lit && props.focusCol === c} hover={pointerMode() && hover() === c} />
        );
      }}</For>
    </View>
  );
}
