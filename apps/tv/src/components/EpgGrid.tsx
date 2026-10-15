import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal } from 'solid-js';
import type { ChannelRow } from '@iptv/app-api';
import { pointerMode, usePointerTarget, type Point } from '../input/pointer.ts';
import { cellAt, type GridGeometry, type GridHit } from '../input/pointerLogic.ts';
import { rawViaDevProxy } from '../net/devProxy.ts';
import { PX_PER_HOUR, VIEW_SPAN, isOnAir, ticks, timeToX, type Block } from '../screens/guideLogic.ts';
import { formatClock } from '../shell/logic.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { logoCache } from './logoCache.ts';
import { renderRange } from './virtualWindow.ts';

export const EPG_ROW_H = 72;
export const EPG_VIEW_ROWS = 8;
export const RULER_H = 44;
export const CHANNEL_W = 260;
/** 3 h at 480 px/h. */
export const TIMELINE_W = 1440;
export const EPG_GRID_W = LAYOUT.width - LAYOUT.safeX * 2;
const TL_X = EPG_GRID_W - TIMELINE_W;
/** Where the timeline starts inside the grid (the Guide puts `‹ Earlier` there). */
export const EPG_TIMELINE_X = TL_X;
/**
 * The grid's layout for pointer hit-testing (`cellAt`), in px relative to the grid node: the channel tiles start at
 * x 0 and are `CHANNEL_W` wide (no margin); the timeline starts at `TL_X`. A row is `EPG_ROW_H` tall including the
 * 6 px gap under its tiles, so a point in that gap counts as the row above.
 */
export const EPG_GEOMETRY: GridGeometry = {
  rulerH: RULER_H, rowH: EPG_ROW_H, viewRows: EPG_VIEW_ROWS, channelW: CHANNEL_W, timelineX: TL_X, timelineW: TIMELINE_W,
  pxPerHour: PX_PER_HOUR,
};
/** Rows drawn beyond each edge of the viewport. */
const ROW_BUFFER = 2;
const CELL_H = EPG_ROW_H - 6;
const BLOCK_GAP = 4;
const LOGO_W = 64;
const LOGO_H = 44;
const NOW_LINE = 0xf5a524ff;
const ON_AIR = 0x1f2939ff;
const FILLER = 0x10141cff;
const ROW_BG = 0x0f131aff;

function Logo(props: { url: string | undefined }) {
  const [failedUrl, setFailedUrl] = createSignal<string | undefined>(undefined);
  const usable = () => failedUrl() !== props.url && logoCache.usable(props.url);
  return (
    <View x={10} y={(CELL_H - LOGO_H) / 2} width={LOGO_W} height={LOGO_H} borderRadius={6} color={COLORS.background}>
      {/* Without a logo the tile stays empty: the number is already shown next to it. */}
      <Show when={usable() ? props.url : undefined} keyed>
        {(url) => {
          logoCache.touch(url);
          return (
            <View x={3} y={3} width={LOGO_W - 6} height={LOGO_H - 6} src={rawViaDevProxy(url)}
              onEvent={{ failed: () => { logoCache.markFailed(url); setFailedUrl(url); } }} />
          );
        }}
      </Show>
    </View>
  );
}

/** Keeps the previous block objects when a rebuild yields the same blocks, so their nodes are reused. */
function reuse(prev: readonly Block[] | undefined, next: Block[]): Block[] {
  if (!prev?.length) return next;
  const old = new Map(prev.map((b) => [`${b.start}:${b.stop}:${b.title}`, b]));
  return next.map((b) => {
    const o = old.get(`${b.start}:${b.stop}:${b.title}`);
    return o && o.desc === b.desc && o.filler === b.filler ? o : b;
  });
}

/**
 * The guide grid: a ruler with 30-minute ticks, a channel column and a 3-hour timeline (480 px/h) with a now
 * line. One focusable node takes the keys (handlers come from the Guide). Virtualised in both directions: only
 * the visible rows plus 2 either side are drawn, and only the blocks overlapping the visible time span.
 *
 * Pointer: one target for the grid. `cellAt` maps the pointer to a channel name or a programme block; hover outlines
 * it, a click reports it (`onCellClick`), the wheel goes to `onPointerWheel`.
 */
export function EpgGrid(props: {
  ref: (el: ElementNode) => void;
  x: number; y: number;
  total: number;
  top: number;
  focusRow: number;
  /** Start of the focused block (identifies it in the focused row). */
  focusStart: number | undefined;
  area: 'grid' | 'channels';
  viewStart: number;
  now: number;
  playingId: string | undefined;
  dayLabel: string;
  channel: (i: number) => ChannelRow | undefined;
  blocks: (i: number) => Block[];
  onUp: () => boolean;
  onDown: () => boolean;
  onLeft: () => boolean;
  onRight: () => boolean;
  onOk: () => boolean;
  onPage: (dir: 1 | -1) => boolean;
  /** Pointer click on a channel name or a programme block. */
  onCellClick?: (hit: GridHit<Block>) => void;
  /** One wheel step per axis (-1, 0 or 1). */
  onPointerWheel?: (dy: number, dx: number) => void;
}) {
  const [focused, setFocused] = createSignal(false);
  const [hover, setHover] = createSignal<GridHit<Block> | undefined>(undefined);
  let node: ElementNode | undefined;
  const height = RULER_H + EPG_VIEW_ROWS * EPG_ROW_H;
  const indices = createMemo(() => {
    const r = renderRange(props.top, EPG_VIEW_ROWS, props.total, ROW_BUFFER);
    return Array.from({ length: r.to - r.from }, (_, i) => r.from + i);
  });
  const nowX = () => timeToX(props.now, props.viewStart);
  const hitAt = (p: Point) => cellAt(p.x, p.y, EPG_GEOMETRY, props.top, props.total, props.viewStart, props.blocks);
  usePointerTarget({
    node: () => node,
    onHover: (p) => setHover(p ? hitAt(p) : undefined),
    onClick: (p) => {
      const hit = hitAt(p);
      if (hit) props.onCellClick?.(hit);
    },
    // The cell: a channel name is -1 - row, a programme block row * 10000 + its index in the row.
    subAt: (p) => {
      const hit = hitAt(p);
      if (!hit) return undefined;
      return hit.area === 'channels' ? -1 - hit.row : hit.row * 10000 + props.blocks(hit.row).indexOf(hit.block);
    },
    onWheel: (dy, dx) => {
      props.onPointerWheel?.(dy, dx);
      return true;
    },
  });
  const hoverChannel = (i: number) => {
    const h = hover();
    return pointerMode() && h?.area === 'channels' && h.row === i;
  };
  const hoverBlock = (i: number, b: Block) => {
    const h = hover();
    return pointerMode() && h?.area === 'grid' && h.row === i && h.block.start === b.start;
  };

  return (
    <View ref={(el) => { node = el; props.ref(el); }} x={props.x} y={props.y} width={EPG_GRID_W} height={height} clipping
      onFocusChanged={setFocused}
      onUp={() => props.onUp()} onDown={() => props.onDown()}
      onLeft={() => props.onLeft()} onRight={() => props.onRight()} onEnter={() => props.onOk()}
      onChannelUp={() => props.onPage(-1)} onChannelDown={() => props.onPage(1)}>
      {/* Ruler */}
      <Text x={10} y={(RULER_H - FONT.small) / 2 - 2} width={CHANNEL_W - 20} maxWidth={CHANNEL_W - 20} contain="width"
        maxLines={1} fontSize={FONT.small} color={COLORS.text}>{props.dayLabel}</Text>
      <For each={ticks(props.viewStart)}>{(t) => (
        <View x={TL_X + timeToX(t, props.viewStart)} y={0} width={240} height={RULER_H}>
          <View x={0} y={RULER_H - 14} width={2} height={14} color={COLORS.muted} />
          <Text x={8} y={(RULER_H - FONT.small) / 2 - 4} fontSize={FONT.small} color={COLORS.muted}>
            {formatClock(new Date(t))}
          </Text>
        </View>
      )}</For>

      {/* Rows */}
      <View y={RULER_H} width={EPG_GRID_W} height={EPG_VIEW_ROWS * EPG_ROW_H} clipping>
        <For each={indices()}>{(i) => {
          const ch = () => props.channel(i);
          const isRow = () => i === props.focusRow;
          const chLit = () => isRow() && focused() && props.area === 'channels';
          const all = createMemo<Block[]>((prev) => reuse(prev, props.blocks(i)));
          const visible = createMemo(() => {
            const from = props.viewStart;
            const to = from + VIEW_SPAN;
            return all().filter((b) => b.stop > from && b.start < to);
          });
          return (
            <View y={(i - props.top) * EPG_ROW_H} width={EPG_GRID_W} height={CELL_H}>
              <View width={CHANNEL_W} height={CELL_H} borderRadius={LAYOUT.radius}
                color={chLit() ? COLORS.focus : isRow() ? COLORS.surface : hoverChannel(i) ? COLORS.hover : ROW_BG}>
                {/* Keyed by the logo string (not the row object), so chunk loads do not remount the logo. */}
                <Logo url={ch()?.logo} />
                <Text x={86} y={8} width={CHANNEL_W - 96} maxWidth={CHANNEL_W - 96} contain="width" maxLines={1}
                  fontSize={FONT.small} color={chLit() ? 0xffffffcc : COLORS.muted}>
                  {`${ch()?.number ?? ''}${ch()?.id === props.playingId && ch() ? ' ▶' : ''}`}
                </Text>
                <Text x={86} y={36} width={CHANNEL_W - 96} maxWidth={CHANNEL_W - 96} contain="width" maxLines={1}
                  fontSize={FONT.small} color={chLit() ? COLORS.onFocus : COLORS.text}>{ch()?.name ?? 'Loading…'}</Text>
              </View>
              <View x={TL_X} width={TIMELINE_W} height={CELL_H} color={ROW_BG} borderRadius={LAYOUT.radius}>
                <For each={visible()}>{(b) => {
                  const x = () => Math.max(0, timeToX(b.start, props.viewStart));
                  const w = () => Math.min(TIMELINE_W, timeToX(b.stop, props.viewStart)) - x() - BLOCK_GAP;
                  const lit = () => isRow() && focused() && props.area === 'grid' && b.start === props.focusStart;
                  const sel = () => isRow() && b.start === props.focusStart;
                  const fill = () => (lit() ? COLORS.focus
                    : sel() ? COLORS.surface : b.filler ? FILLER : isOnAir(b, props.now) ? ON_AIR : COLORS.surface);
                  const ring = () => (sel() && !lit() ? { width: 2, color: COLORS.focus }
                    : !lit() && hoverBlock(i, b) ? { width: 2, color: COLORS.muted } : undefined);
                  const textW = () => Math.max(0, w() - 24);
                  return (
                    <View x={x()} width={Math.max(2, w())} height={CELL_H} color={fill()} borderRadius={8} border={ring()}>
                      <Show when={w() > 48}>
                        <Text x={12} y={(CELL_H - FONT.body) / 2 - 3} width={textW()} maxWidth={textW()} contain="width"
                          maxLines={1} fontSize={FONT.body}
                          color={lit() ? COLORS.onFocus : b.filler ? COLORS.muted : COLORS.text}>{b.title}</Text>
                      </Show>
                    </View>
                  );
                }}</For>
              </View>
            </View>
          );
        }}</For>
      </View>

      {/* Now line */}
      <Show when={nowX() >= 0 && nowX() <= TIMELINE_W}>
        <View x={TL_X + nowX() - 1} y={RULER_H - 8} width={3} height={8 + EPG_VIEW_ROWS * EPG_ROW_H} color={NOW_LINE}
          zIndex={5} />
        <View x={TL_X + nowX() - 6} y={RULER_H - 12} width={13} height={13} borderRadius={6.5} color={NOW_LINE} zIndex={5} />
      </Show>
    </View>
  );
}
