import { For, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, createMemo, createSignal, on } from 'solid-js';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { stopMotion, tween } from '../shell/motion.ts';
import { MOTION } from '../shell/theme.ts';
import { WIDE_GAP, WideTile, wideSize, type WideCell } from './WideTile.tsx';
import { renderRange, scrollTopFor } from './virtualWindow.ts';

/** Tiles fully visible by default. */
const VISIBLE = 5;
const BUFFER = 2;

/** One horizontally virtualised row of wide tiles (not focusable: the screen owns the keys). */
export function WideRow(props: {
  x: number; y: number; width: number; row: { readonly cells: readonly WideCell[] }; focusCol: number | undefined; lit: boolean; now: number;
  /** Tiles fully visible (default 5); the focused column scrolls within this window. */
  visible?: number;
  /** Channel cards show their number (see `WideTile`). */
  channelNumbers?: boolean;
  /** Compact tiles (Start's match and channel rows, see `WideTile`). */
  compact?: boolean;
  onCellClick?: (col: number) => void; onCellOptions?: (col: number) => void; onWheel?: (dy: number, dx: number) => boolean;
}) {
  const [hover, setHover] = createSignal<number | undefined>(undefined);
  let node: ElementNode | undefined;
  /** The tiles sit at fixed x's on one strip; scrolling moves only the strip (one animation, not N tile writes). */
  let strip: ElementNode | undefined;
  let lastScroll = 0;
  const cells = () => props.row.cells.length;
  const visible = () => props.visible ?? VISIBLE;
  const size = () => wideSize(props.compact === true);
  const pitch = () => size().w + WIDE_GAP;
  const scroll = createMemo(() => {
    if (props.focusCol !== undefined) lastScroll = scrollTopFor(props.focusCol, lastScroll, visible(), cells());
    else lastScroll = Math.min(lastScroll, Math.max(0, cells() - visible()));
    return lastScroll;
  });
  const cols = createMemo(() => {
    const r = renderRange(scroll(), visible(), cells(), BUFFER);
    return Array.from({ length: r.to - r.from }, (_, i) => r.from + i);
  });
  // The strip glides to the scroll (180 ms; linear for the key gap while a key is held). A jump of more than a window
  // (a new row, Home/End) or a pitch change (compact toggled) snaps. The pointer keeps using `scroll()`, the target.
  createEffect(on([scroll, pitch] as const, ([s, p], prev) => {
    if (!strip) return;
    const x = -s * p;
    if (prev === undefined || prev[1] !== p || Math.abs(s - prev[0]) > visible()) { stopMotion(strip); strip.x = x; return; }
    tween(strip, { x }, MOTION.rowScroll);
  }));
  const colAt = (px: number) => {
    const c = scroll() + Math.floor(px / pitch());
    return px % pitch() < size().w && c < cells() ? c : undefined;
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
    <View ref={(el) => { node = el; }} x={props.x} y={props.y} width={props.width} height={size().h}>
      <View ref={(el) => { strip = el; }} width={Math.max(1, cells()) * pitch()} height={size().h}>
        <For each={cols()}>{(c) => (
          <WideTile x={c * pitch()} y={0} cell={props.row.cells[c]!} now={props.now} channelNumbers={props.channelNumbers}
            compact={props.compact}
            lit={props.lit && props.focusCol === c} hover={pointerMode() && hover() === c} />
        )}</For>
      </View>
    </View>
  );
}
