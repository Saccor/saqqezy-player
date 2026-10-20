import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal } from 'solid-js';
import { pointerMode, usePointerTarget, type Point } from '../input/pointer.ts';
import { rowAt } from '../input/pointerLogic.ts';
import { dayLabel } from '../screens/guideLogic.ts';
import { formatRange, progressOf } from '../screens/homeLogic.ts';
import { vodLine, type SearchRow } from '../screens/searchLogic.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { BAR_H, ChannelRowView, LOGO_H_PX, LOGO_W_PX, Logo, NUM_W_PX, ROW_FOCUS_FILL, ROW_H, TRACK } from './ChannelList.tsx';
import { renderRange } from './virtualWindow.ts';

/** A programme row: title on top, "when · channel" below, progress while on air. */
function ProgrammeRowView(props: {
  y: number; width: number; row: Extract<SearchRow, { kind: 'onNow' | 'later' }>; lit: boolean; isFocus: boolean; now: number;
  hover?: boolean;
}) {
  const fill = () => (props.lit ? ROW_FOCUS_FILL : props.isFocus ? COLORS.surface : props.hover ? COLORS.hover : 0x00000000);
  const textMain = () => (props.lit ? COLORS.onFocus : COLORS.text);
  const textSub = () => (props.lit ? COLORS.onFocusMuted : COLORS.muted);
  const textX = NUM_W_PX + LOGO_W_PX + 20;
  const textW = props.width - textX - 20;
  const hit = () => props.row.hit;
  const title = () => hit().title;
  const sub = () => {
    const h = hit();
    const ch = `${h.channel.number} ${h.channel.name}`;
    const row = props.row;
    if (row.kind === 'onNow') return `${formatRange(row.hit.start, row.hit.stop)} · ${ch}`;
    const more = row.hit.more;
    return `${dayLabel(row.hit.start, props.now)} ${formatRange(row.hit.start, row.hit.stop)} · ${ch}${more > 0 ? ` · +${more} more` : ''}`;
  };
  return (
    <View x={0} y={props.y} width={props.width} height={ROW_H - 6} color={fill()} borderRadius={LAYOUT.radius}>
      <Logo x={NUM_W_PX} y={(ROW_H - 6 - LOGO_H_PX) / 2} url={hit().channel.logo} number={hit().channel.number} focused={props.lit} />
      <Text x={textX} y={8} width={textW} maxWidth={textW} contain="width" maxLines={1} fontSize={FONT.body} color={textMain()}>{title()}</Text>
      <Text x={textX} y={42} width={textW} maxWidth={textW} contain="width" maxLines={1} fontSize={FONT.small} color={textSub()}>{sub()}</Text>
      <Show when={props.row.kind === 'onNow'}>
        <View x={textX} y={ROW_H - 6 - BAR_H - 4} width={textW} height={BAR_H} color={props.lit ? COLORS.onFocusTrack : TRACK}>
          <View width={Math.round(textW * progressOf(hit(), props.now))} height={BAR_H} color={props.lit ? COLORS.onFocus : COLORS.accent} />
        </View>
      </Show>
    </View>
  );
}

/** A movie or series row: compact (no poster, to keep Search fast): "title · year", the kind and state below. */
function VodRowView(props: {
  y: number; width: number; row: Extract<SearchRow, { kind: 'vod' }>; lit: boolean; isFocus: boolean; hover?: boolean;
}) {
  const fill = () => (props.lit ? ROW_FOCUS_FILL : props.isFocus ? COLORS.surface : props.hover ? COLORS.hover : 0x00000000);
  const textX = NUM_W_PX + LOGO_W_PX + 20;
  const textW = props.width - textX - 20;
  const t = () => props.row.tile;
  const sub = () => {
    const parts = [t().kind === 'movie' ? 'Movie' : 'Series'];
    if (t().badge) parts.push(t().badge!);
    if (t().watched) parts.push('Watched');
    if (t().favourite) parts.push('In favourites');
    return parts.join(' · ');
  };
  return (
    <View x={0} y={props.y} width={props.width} height={ROW_H - 6} color={fill()} borderRadius={LAYOUT.radius}>
      <Text x={textX} y={8} width={textW} maxWidth={textW} contain="width" maxLines={1} fontSize={FONT.body}
        color={props.lit ? COLORS.onFocus : COLORS.text}>{vodLine(t())}</Text>
      <Text x={textX} y={42} width={textW} maxWidth={textW} contain="width" maxLines={1} fontSize={FONT.small}
        color={props.lit ? COLORS.onFocusMuted : COLORS.muted}>{sub()}</Text>
      <Show when={t().progress !== undefined}>
        <View x={textX} y={ROW_H - 6 - BAR_H - 4} width={textW} height={BAR_H} color={props.lit ? COLORS.onFocusTrack : TRACK}>
          <View width={Math.round(textW * (t().progress ?? 0))} height={BAR_H} color={props.lit ? COLORS.onFocus : COLORS.accent} />
        </View>
      </Show>
    </View>
  );
}

/**
 * Virtualised search results: section headers, channel rows, movie and series rows, programme rows and trailing notes. One focusable
 * node handles the keys; the caller keeps focus on selectable rows.
 *
 * Pointer: one target for the list. Hover highlights a channel or programme row (never focus); clicks report the
 * row (the caller ignores headers and notes); a wheel step is `onWheelStep` (default `onMove`).
 */
export function SearchResultList(props: {
  ref: (el: ElementNode) => void;
  x: number; y: number; width: number; height: number;
  rows: readonly SearchRow[];
  top: number;
  focus: number;
  now: number;
  playingId: string | undefined;
  onMove: (delta: 1 | -1) => boolean;
  onPage: (dir: 1 | -1) => boolean;
  onLeft: () => boolean;
  onOk: () => boolean;
  /** Pointer click on row `index` (`double`: the second click of a double click on the same row). */
  onRowClick?: (index: number, double: boolean) => void;
  /** One wheel step (default: `onMove`). */
  onWheelStep?: (delta: 1 | -1) => void;
}) {
  const [focused, setFocused] = createSignal(false);
  const [hoverRow, setHoverRow] = createSignal<number | undefined>(undefined);
  let node: ElementNode | undefined;
  const viewRows = () => Math.max(1, Math.floor(props.height / ROW_H));
  const indices = createMemo(() => {
    const r = renderRange(props.top, viewRows(), props.rows.length);
    return Array.from({ length: r.to - r.from }, (_, i) => r.from + i);
  });
  const indexAt = (p: Point) => rowAt(p.y, props.top, ROW_H, props.rows.length);
  const click = (p: Point, double: boolean) => {
    const i = indexAt(p);
    if (i === undefined) return;
    props.onRowClick?.(i, double);
  };
  usePointerTarget({
    node: () => node,
    onHover: (p) => setHoverRow(p ? indexAt(p) : undefined),
    onClick: (p) => click(p, false),
    onDoubleClick: (p) => click(p, true),
    subAt: indexAt, // a double click needs both clicks on the same row
    onWheel: (dy) => {
      if (dy !== 0) {
        const d = dy > 0 ? 1 : -1;
        if (props.onWheelStep) props.onWheelStep(d);
        else props.onMove(d);
      }
      return true;
    },
  });
  return (
    <View ref={(el) => { node = el; props.ref(el); }} x={props.x} y={props.y} width={props.width} height={props.height} clipping
      onFocusChanged={(f: boolean) => setFocused(f)}
      onUp={() => props.onMove(-1)} onDown={() => props.onMove(1)}
      onChannelUp={() => props.onPage(-1)} onChannelDown={() => props.onPage(1)}
      onLeft={() => props.onLeft()} onEnter={() => props.onOk()}
      onLongOk={() => true} onMenu={() => true}>
      <For each={indices()}>{(i) => {
        const r = () => props.rows[i];
        const y = () => (i - props.top) * ROW_H;
        const lit = () => i === props.focus && focused();
        const isFocus = () => i === props.focus;
        const hover = () => pointerMode() && hoverRow() === i;
        return (
          <Show when={r()} keyed>{(row) => {
            if (row.kind === 'header' || row.kind === 'note') {
              return (
                <Text x={12} y={y() + ROW_H - 6 - FONT.small - 10} width={props.width - 24} maxWidth={props.width - 24}
                  contain="width" maxLines={1} fontSize={FONT.small} color={COLORS.muted}>{row.label}</Text>
              );
            }
            if (row.kind === 'channel') {
              return <ChannelRowView y={y()} width={props.width} row={row.channel} lit={lit()} isFocus={isFocus()}
                now={props.now} playingId={props.playingId} showNext hover={hover()} />;
            }
            if (row.kind === 'vod') {
              return <VodRowView y={y()} width={props.width} row={row} lit={lit()} isFocus={isFocus()} hover={hover()} />;
            }
            return <ProgrammeRowView y={y()} width={props.width} row={row} lit={lit()} isFocus={isFocus()} now={props.now}
              hover={hover()} />;
          }}</Show>
        );
      }}</For>
    </View>
  );
}
