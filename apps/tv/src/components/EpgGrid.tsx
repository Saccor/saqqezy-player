import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal } from 'solid-js';
import type { ChannelRow } from '@iptv/app-api';
import { pointerMode, usePointerTarget, type Point } from '../input/pointer.ts';
import { cellAt, sameGridHit, type GridGeometry, type GridHit } from '../input/pointerLogic.ts';
import { imageSrc } from '../images/imageSrc.ts';
import { cellBadge } from '../playback/sourceLogic.ts';
import { PX_PER_HOUR, VIEW_SPAN, isOnAir, monogram, ticks, timeToX, type Block } from '../screens/guideLogic.ts';
import { formatClock } from '../shell/logic.ts';
import { iconTexture } from '../vod/icons.ts';
import { centerText, COLORS, LAYOUT, RADIUS, SPACE, STRONG, TYPE } from '../shell/theme.ts';
import { BADGE_H, Badge, badgeWidth } from './Badge.tsx';
import { logoCache } from './logoCache.ts';
import { logoKey } from './logoKey.ts';
import { renderRange } from './virtualWindow.ts';

export const EPG_ROW_H = 60;
export const EPG_CELL_H = 56;
export const EPG_VIEW_ROWS = 11;
/** Pointer mode: the bottom button row (y 978) must stay clear. */
export const EPG_POINTER_ROWS = 10;
export const RULER_H = 44;
/** Wide enough for a full channel name next to the number and logo (308 px of text). */
export const CHANNEL_W = 440;
/** 2 h at 612 px/h. */
export const TIMELINE_W = 1224;
export const EPG_GRID_X = LAYOUT.contentX;
export const EPG_GRID_W = LAYOUT.contentW;
/** The timeline starts right after the channel column. */
const TL_X = CHANNEL_W;
/**
 * The grid's layout for pointer hit-testing (`cellAt`), in px relative to the grid node: the channel tiles start at
 * x 0 and are `CHANNEL_W` wide; the timeline starts at `TL_X`. A row is `EPG_ROW_H` tall including the 4 px gap
 * under its tiles, so a point in that gap counts as the row above.
 */
export const EPG_GEOMETRY: GridGeometry = {
  rulerH: RULER_H, rowH: EPG_ROW_H, viewRows: EPG_VIEW_ROWS, channelW: CHANNEL_W, timelineX: TL_X, timelineW: TIMELINE_W,
  pxPerHour: PX_PER_HOUR,
};
/** Rows drawn beyond each edge of the viewport. */
const ROW_BUFFER = 2;
const CELL_H = EPG_CELL_H;
/** The cell badge sits vertically centred in the cell (a pill, not text, so no text nudge). */
const BADGE_Y = (CELL_H - BADGE_H) / 2;
const BLOCK_GAP = SPACE.s;
/** A ruler tick's height. */
const TICK_H = SPACE.m;
/** The now line's width. */
const NOW_W = 2;
const PAD_X = 16;
const NUM_W = 44;
const LOGO = 40;
const LOGO_X = 8 + NUM_W + 12;
const NAME_X = LOGO_X + LOGO + 12;
const NAME_W = CHANNEL_W - BLOCK_GAP - NAME_X - 12;
/** Between the name and a combined channel's badge. */
const BADGE_GAP = 8;
/** The archive glyph (catch-up marks): drawn before a past block's title, at the end of an on-air one. */
const MARK = 20;
/** Text sits a little above the exact middle so the glyphs look centred. */
const TEXT_Y = (CELL_H - TYPE.meta) / 2 - 2;

function Logo(props: { url: string | undefined; name: string | undefined }) {
  const [failedUrl, setFailedUrl] = createSignal<string | undefined>(undefined);
  const key = () => logoKey(props.url, failedUrl(), (u) => logoCache.usable(u));
  return (
    <View x={LOGO_X} y={(CELL_H - LOGO) / 2} width={LOGO} height={LOGO} borderRadius={RADIUS.card} color={COLORS.surfaceRaised}>
      {/* No logo in the user's own data: a tile with two initials. */}
      <Show when={key() === undefined}>
        <Text y={centerText(LOGO, TYPE.meta)} width={LOGO} maxWidth={LOGO} contain="width" textAlign="center" maxLines={1}
          fontSize={TYPE.meta} color={COLORS.muted} {...STRONG}>{monogram(props.name ?? '')}</Text>
      </Show>
      <Show when={key()} keyed>
        {(url) => {
          logoCache.touch(url);
          return (
            <View width={LOGO} height={LOGO} borderRadius={RADIUS.card} src={imageSrc(url, LOGO, LOGO)}
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
    return o && o.desc === b.desc && o.filler === b.filler && o.archive === b.archive ? o : b;
  });
}

/**
 * The guide grid: a ruler with 30-minute ticks, a channel column and a 2-hour timeline (612 px/h) with a now
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
  /** Rows shown (default `EPG_VIEW_ROWS`; pointer mode passes `EPG_POINTER_ROWS`). */
  rows?: number;
  focusRow: number;
  /** Start of the focused block (identifies it in the focused row). */
  focusStart: number | undefined;
  area: 'grid' | 'channels';
  viewStart: number;
  now: number;
  playingId: string | undefined;
  channel: (i: number) => ChannelRow | undefined;
  blocks: (i: number) => Block[];
  onUp: () => boolean;
  onDown: () => boolean;
  onLeft: () => boolean;
  onRight: () => boolean;
  onOk: () => boolean;
  onPage: (dir: 1 | -1) => boolean;
  /** Menu: Live TV's one menu (programme items, then the channel's). */
  onMenu?: () => boolean;
  /** Long Ok: the same options as Menu. */
  onLongOk?: () => boolean;
  /**
   * The archive mark of a block (spec 2026-10-20-catch-up §5.1): `past` for a programme the archive can play,
   * `onAir` for one on a catch-up channel that can play from its start. Not by colour alone: a glyph.
   */
  archiveMark?: (row: number, b: Block) => 'past' | 'onAir' | undefined;
  /** Pointer click on a channel name or a programme block. */
  onCellClick?: (hit: GridHit<Block>) => void;
  /** Pointer right click on a channel name or a programme block (Live TV: the menu). */
  onCellContextMenu?: (hit: GridHit<Block>) => void;
  /** One wheel step per axis (-1, 0 or 1). */
  onPointerWheel?: (dy: number, dx: number) => void;
  /** False: the pointer passes over the grid (a modal keyboard is open). Default true. */
  pointerEnabled?: boolean;
}) {
  const [focused, setFocused] = createSignal(false);
  // Equal by cell: a move within one cell sets nothing.
  const [hover, setHover] = createSignal<GridHit<Block> | undefined>(undefined, { equals: sameGridHit });
  let node: ElementNode | undefined;
  const viewRows = () => props.rows ?? EPG_VIEW_ROWS;
  const height = () => RULER_H + viewRows() * EPG_ROW_H;
  const indices = createMemo(() => {
    const r = renderRange(props.top, viewRows(), props.total, ROW_BUFFER);
    return Array.from({ length: r.to - r.from }, (_, i) => r.from + i);
  });
  const nowX = () => timeToX(props.now, props.viewStart);
  const hitAt = (p: Point) => cellAt(p.x, p.y, { ...EPG_GEOMETRY, viewRows: viewRows() }, props.top, props.total, props.viewStart, props.blocks);
  usePointerTarget({
    node: () => node,
    enabled: () => props.pointerEnabled !== false,
    onHover: (p) => setHover(p ? hitAt(p) : undefined),
    onClick: (p) => {
      const hit = hitAt(p);
      if (hit) props.onCellClick?.(hit);
    },
    onContextMenu: (p) => {
      const hit = hitAt(p);
      if (hit) props.onCellContextMenu?.(hit);
    },
    onWheel: (dy, dx) => {
      props.onPointerWheel?.(dy, dx);
      return true;
    },
  });
  /** The pointer is over the guide: only the hovered cell is drawn lit (hover == focus, one lit at a time). */
  const hoverActive = () => pointerMode() && hover() !== undefined;
  const hoverChannel = (i: number) => {
    const h = hover();
    return pointerMode() && h?.area === 'channels' && h.row === i;
  };
  const hoverBlock = (i: number, b: Block) => {
    const h = hover();
    return pointerMode() && h?.area === 'grid' && h.row === i && h.block.start === b.start;
  };

  return (
    <View ref={(el) => { node = el; props.ref(el); }} x={props.x} y={props.y} width={EPG_GRID_W} height={height()} clipping
      onFocusChanged={setFocused}
      onUp={() => props.onUp()} onDown={() => props.onDown()}
      onLeft={() => props.onLeft()} onRight={() => props.onRight()} onEnter={() => props.onOk()}
      onChannelUp={() => props.onPage(-1)} onChannelDown={() => props.onPage(1)}
      onMenu={() => props.onMenu?.() ?? false} onLongOk={() => props.onLongOk?.() ?? false}>
      {/* Ruler (its channel column holds the screen's group dropdown) */}
      <For each={ticks(props.viewStart)}>{(t) => (
        <View x={TL_X + timeToX(t, props.viewStart)} y={0} width={240} height={RULER_H}>
          <View x={0} y={RULER_H - TICK_H} width={2} height={TICK_H} color={COLORS.track} />
          <Text x={8} y={centerText(RULER_H, TYPE.meta)} fontSize={TYPE.meta} color={COLORS.subtle}>
            {formatClock(new Date(t))}
          </Text>
        </View>
      )}</For>

      {/* Rows */}
      <View y={RULER_H} width={EPG_GRID_W} height={viewRows() * EPG_ROW_H} clipping>
        <For each={indices()}>{(i) => {
          const ch = () => props.channel(i);
          const isRow = () => i === props.focusRow;
          const chLit = () => isRow() && focused() && props.area === 'channels';
          // Hover is drawn as focus (one hover style); the focused row's channel cell while focus is elsewhere is only a cursor.
          const chOn = () => (hoverActive() ? hoverChannel(i) : chLit());
          // A combined channel's badge ("4K", or "×3") at the cell's right end; the name takes what is left.
          const badge = () => cellBadge(ch()?.quality, ch()?.sourceCount);
          const badgeW = () => (badge() === '' ? 0 : badgeWidth(badge()));
          const nameW = () => (badgeW() > 0 ? NAME_W - badgeW() - BADGE_GAP : NAME_W);
          const all = createMemo<Block[]>((prev) => reuse(prev, props.blocks(i)));
          const visible = createMemo(() => {
            const from = props.viewStart;
            const to = from + VIEW_SPAN;
            return all().filter((b) => b.stop > from && b.start < to);
          });
          return (
            <View y={(i - props.top) * EPG_ROW_H} width={EPG_GRID_W} height={CELL_H}>
              <View width={CHANNEL_W - BLOCK_GAP} height={CELL_H} borderRadius={RADIUS.card}
                color={chOn() ? COLORS.focus : COLORS.transparent}>
                <Text x={8} y={TEXT_Y} width={NUM_W} maxWidth={NUM_W} contain="width" textAlign="right" maxLines={1}
                  fontSize={TYPE.meta} color={chOn() ? COLORS.onFocusMuted : COLORS.subtle}>{`${ch()?.number ?? ''}`}</Text>
                {/* Keyed by the logo string (not the row object), so chunk loads do not remount the logo. */}
                <Logo url={ch()?.logo} name={ch()?.name} />
                <Text x={NAME_X} y={TEXT_Y} width={nameW()} maxWidth={nameW()} contain="width" maxLines={1}
                  fontSize={TYPE.meta} color={chOn() ? COLORS.onFocus : COLORS.text}>
                  {ch() ? `${ch()!.id === props.playingId ? '▶ ' : ''}${ch()!.name}` : 'Loading…'}
                </Text>
                <Show when={badgeW() > 0}>
                  <Badge x={NAME_X + NAME_W - badgeW()} y={BADGE_Y} text={badge()} lit={chOn()} />
                </Show>
              </View>
              <View x={TL_X} width={TIMELINE_W} height={CELL_H}>
                <For each={visible()}>{(b) => {
                  const x = () => Math.max(0, timeToX(b.start, props.viewStart));
                  const w = () => Math.min(TIMELINE_W, timeToX(b.stop, props.viewStart)) - x() - BLOCK_GAP;
                  const lit = () => (hoverActive() ? hoverBlock(i, b) : isRow() && focused() && props.area === 'grid' && b.start === props.focusStart);
                  const live = () => !b.filler && isOnAir(b, props.now);
                  const fill = () => (lit() ? COLORS.focus : live() ? COLORS.surfaceRaised : COLORS.surface);
                  const mark = () => (b.filler ? undefined : props.archiveMark?.(i, b));
                  const textX = () => (mark() === 'past' ? PAD_X + MARK + 8 : PAD_X);
                  const textW = () => Math.max(0, w() - textX() - PAD_X - (mark() === 'onAir' ? MARK + 8 : 0));
                  return (
                    <View x={x()} width={Math.max(2, w())} height={CELL_H} color={fill()} borderRadius={RADIUS.card}>
                      <Show when={mark() && w() > 48 + MARK}>
                        <View x={mark() === 'past' ? PAD_X : w() - PAD_X - MARK} y={(CELL_H - MARK) / 2} width={MARK} height={MARK}
                          src={iconTexture('archive')} color={lit() ? COLORS.onFocus : COLORS.muted} />
                      </Show>
                      <Show when={w() > 48}>
                        <Text x={textX()} y={TEXT_Y} width={textW()} maxWidth={textW()} contain="width"
                          maxLines={1} fontSize={TYPE.meta}
                          color={lit() ? COLORS.onFocus : live() ? COLORS.text : COLORS.muted}>{b.title}</Text>
                      </Show>
                    </View>
                  );
                }}</For>
              </View>
            </View>
          );
        }}</For>
      </View>

      {/* Now line: 2 px, from the ruler to the last row. */}
      <Show when={nowX() >= 0 && nowX() <= TIMELINE_W}>
        <View x={TL_X + nowX() - NOW_W / 2} y={RULER_H} width={NOW_W} height={viewRows() * EPG_ROW_H - (EPG_ROW_H - CELL_H)}
          color={COLORS.accent} zIndex={5} />
      </Show>
    </View>
  );
}
