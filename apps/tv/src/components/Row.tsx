import { For, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, createMemo, createSignal, on, untrack } from 'solid-js';
import type { EpisodeView, VodTile } from '@iptv/app-api';
import { VOD_COPY } from '../copy/vod.ts';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { stopMotion, tween } from '../shell/motion.ts';
import { MOTION } from '../shell/theme.ts';
import { platformId } from '../state/appState.ts';
import { isTvPlatform } from '../video/engineConfig.ts';
import { cellAt, cellCount, drawnCells, type Cell, type RowModel } from '../vod/browseLogic.ts';
import { rowColAt, rowCols, rowDefaults, rowScroll, rowSnaps } from './rowLogic.ts';
import { Tile } from './Tile.tsx';
import { EP_SKELETON, tileGap, tileRowHeight, tileSize } from './tileLogic.ts';
import type { WideCell } from './wideTileLogic.ts';

export type RowContent =
  | { variant: 'poster'; row: RowModel }
  | { variant: 'wide' | 'wideCompact'; cells: readonly WideCell[]; now: number; channelNumbers?: boolean }
  | { variant: 'episode'; episodes: readonly EpisodeView[] | undefined };

const TV = isTvPlatform(platformId);
const tileOf = (cell: Cell): VodTile | undefined => (cell.kind === 'tile' ? cell.tile : undefined);

/**
 * One horizontally virtualised row of tiles (spec 2026-10-26 §1.3), not focusable: the screen owns the keys. The focused
 * column stays in view, moving the row as little as possible; the tiles sit at fixed x's on one strip, and only the strip
 * moves. Pointer: click or right click on a tile reports its column.
 */
export function Row(props: {
  x: number; y: number; width: number;
  content: RowContent;
  focusCol: number | undefined;
  lit: boolean;
  visible?: number;
  w?: number; h?: number;
  onCellClick?: (col: number) => void;
  onCellOptions?: (col: number) => void;
  onWheel?: (dy: number, dx: number) => boolean;
}) {
  const [hover, setHover] = createSignal<number | undefined>(undefined);
  let node: ElementNode | undefined;
  let strip: ElementNode | undefined;
  let last = 0;
  let prev: { scroll: number; pitch: number } | undefined;
  const c = () => props.content;
  const poster = () => c() as Extract<RowContent, { variant: 'poster' }>;
  const wide = () => c() as Extract<RowContent, { variant: 'wide' | 'wideCompact' }>;
  const episode = () => c() as Extract<RowContent, { variant: 'episode' }>;
  // A mounted row's variant never changes (callers key rows by id). Read it untracked: size, pitch and height must follow
  // only the size props, not every signal inside the caller's content literal (which would restart the glide).
  const variant = untrack(() => c().variant);
  const defaults = () => rowDefaults(variant, TV);
  const size = createMemo(() => tileSize(variant, { w: props.w, h: props.h }), undefined, { equals: (a, b) => a.w === b.w && a.h === b.h });
  const pitch = createMemo(() => size().w + tileGap(variant));
  const visible = () => props.visible ?? defaults().visible;
  const cells = () => {
    const x = c();
    if (x.variant === 'poster') return cellCount(x.row);
    if (x.variant === 'episode') return x.episodes ? x.episodes.length : EP_SKELETON;
    return x.cells.length;
  };
  const drawn = () => { const x = c(); return x.variant === 'poster' ? drawnCells(x.row) : cells(); };
  /** Skeleton episode cards take no clicks. */
  const hits = () => { const x = c(); return x.variant === 'episode' && !x.episodes ? 0 : cells(); };
  const scroll = createMemo(() => (last = rowScroll(props.focusCol, last, visible(), cells())));
  const cols = createMemo(() => rowCols(scroll(), visible(), drawn(), defaults().buffer));
  createEffect(on([scroll, pitch] as const, ([s, p]) => {
    if (!strip) return;
    const x = -s * p;
    if (rowSnaps(prev, s, p, visible())) { stopMotion(strip); strip.x = x; } else tween(strip, { x }, MOTION.rowScroll);
    prev = { scroll: s, pitch: p };
  }));
  const colAt = (px: number) => rowColAt(px, scroll(), pitch(), size().w, hits());
  usePointerTarget({
    node: () => node,
    onHover: (p) => setHover(p ? colAt(p.x) : undefined),
    subAt: (p) => colAt(p.x),
    onClick: (p) => { const col = colAt(p.x); if (col !== undefined) props.onCellClick?.(col); },
    onContextMenu: (p) => { const col = colAt(p.x); if (col !== undefined) props.onCellOptions?.(col); },
    onWheel: (dy, dx) => props.onWheel?.(dy, dx) ?? false,
  });
  const h = () => tileRowHeight(variant, size().h);
  return (
    <View ref={(el) => { node = el; }} x={props.x} y={props.y} width={props.width} height={h()}>
      <View ref={(el) => { strip = el; }} width={Math.max(1, cells()) * pitch()} height={h()}>
        <For each={cols()}>{(col) => {
          const lit = () => props.lit && props.focusCol === col;
          const hov = () => pointerMode() && hover() === col;
          // Content (a refreshed `now`, new cells) changes while mounted: every
          // content read below sits in a prop getter, so the tile follows it.
          if (variant === 'poster') {
            const cell = () => cellAt(poster().row, col);
            return <Tile variant="poster" x={col * pitch()} y={0} w={size().w} h={size().h} lit={lit()} hover={hov()}
              tile={tileOf(cell())} label={cell().kind === 'viewAll' ? VOD_COPY.viewAll : undefined} />;
          }
          if (variant === 'episode') return <Tile variant="episode" x={col * pitch()} y={0} lit={lit()} hover={hov()} ep={episode().episodes?.[col]} />;
          return <Tile variant={variant} x={col * pitch()} y={0} lit={lit()} hover={hov()} cell={wide().cells[col]!} now={wide().now}
            channelNumbers={wide().channelNumbers} />;
        }}</For>
      </View>
    </View>
  );
}
