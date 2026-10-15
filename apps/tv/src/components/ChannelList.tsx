import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal } from 'solid-js';
import type { ChannelRow } from '@iptv/app-api';
import { pointerMode, usePointerTarget, type Point } from '../input/pointer.ts';
import { ROW_OPTIONS_H, ROW_OPTIONS_LABEL, ROW_OPTIONS_PAD, ROW_OPTIONS_W, rowAt, rowTextEnd } from '../input/pointerLogic.ts';
import { rawViaDevProxy } from '../net/devProxy.ts';
import { formatRange, progressOf } from '../screens/homeLogic.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { logoCache } from './logoCache.ts';
import { renderRange } from './virtualWindow.ts';

export const ROW_H = 84;
const NUM_W = 76;
const LOGO_W = 104;
const LOGO_H = 60;
export const NUM_W_PX = NUM_W;
export const LOGO_W_PX = LOGO_W;
export const LOGO_H_PX = LOGO_H;
export const BAR_H = 4;
export const ROW_FOCUS_FILL = COLORS.focus;
export const TRACK = 0x2a3140ff;
/** The `⋯` options button at the right end of the hovered row (pointer mode). */
const DOTS_W = ROW_OPTIONS_W;
const DOTS_H = ROW_OPTIONS_H;
const DOTS_PAD = ROW_OPTIONS_PAD;

export function Logo(props: { x: number; y: number; url: string | undefined; number: number; focused: boolean }) {
  // Re-evaluated when the row's channel changes; a failed load flips the row to the number tile.
  const [failed, setFailed] = createSignal(false);
  const usable = () => !failed() && logoCache.usable(props.url);
  return (
    <View x={props.x} y={props.y} width={LOGO_W} height={LOGO_H} borderRadius={8}
      color={props.focused ? 0xffffff26 : COLORS.surface}>
      <Show when={usable() ? props.url : undefined} keyed fallback={
        <Text y={(LOGO_H - FONT.small) / 2 - 2} width={LOGO_W} maxWidth={LOGO_W} contain="width" textAlign="center"
          fontSize={FONT.small} color={COLORS.muted}>{`${props.number}`}</Text>
      }>
        {(url) => {
          logoCache.touch(url);
          return (
            <View x={4} y={4} width={LOGO_W - 8} height={LOGO_H - 8} src={rawViaDevProxy(url)}
              onEvent={{ failed: () => { logoCache.markFailed(url); setFailed(true); } }} />
          );
        }}
      </Show>
    </View>
  );
}

/** One channel row (number, logo, name, now line, progress), positioned by the caller. */
export function ChannelRowView(props: {
  y: number; width: number; row: ChannelRow | undefined; lit: boolean; isFocus: boolean;
  now: number; playingId: string | undefined; showNext?: boolean;
  /** The pointer is over the row (pointer mode): a subtle fill, never focus. */
  hover?: boolean;
  /** The `⋯` pill shows on this row: the text and progress bar end before it. */
  optionsShown?: boolean;
}) {
  const r = () => props.row;
  const fill = () => (props.lit ? ROW_FOCUS_FILL : props.isFocus ? COLORS.surface : props.hover ? COLORS.hover : 0x00000000);
  const textMain = () => (props.lit ? COLORS.onFocus : COLORS.text);
  const textSub = () => (props.lit ? 0xffffffcc : COLORS.muted);
  const textX = NUM_W + LOGO_W + 20;
  const textW = () => rowTextEnd(props.width, props.optionsShown === true) - textX;
  const nowLine = () => {
    const n = r()?.now;
    const nx = props.showNext ? r()?.next : undefined;
    if (!n) return r() ? 'No guide information' : '';
    return `${formatRange(n.start, n.stop)} · ${n.title}${nx ? ` | Next: ${nx.title}` : ''}`;
  };
  return (
    <View x={0} y={props.y} width={props.width} height={ROW_H - 6} color={fill()} borderRadius={LAYOUT.radius}>
      <Text x={12} y={(ROW_H - 6 - FONT.body) / 2 - 3} width={NUM_W - 16} maxWidth={NUM_W - 16} contain="width"
        textAlign="right" fontSize={FONT.body} color={textSub()}>{`${r()?.number ?? ''}`}</Text>
      <Show when={r()} keyed>
        {(row) => <Logo x={NUM_W} y={(ROW_H - 6 - LOGO_H) / 2} url={row.logo} number={row.number} focused={props.lit} />}
      </Show>
      <Text x={textX} y={8} width={textW()} maxWidth={textW()} contain="width" maxLines={1}
        fontSize={FONT.body} color={textMain()}>
        {`${r()?.name ?? 'Loading…'}${r()?.id === props.playingId && r() ? ' ▶' : ''}`}
      </Text>
      <Text x={textX} y={42} width={textW()} maxWidth={textW()} contain="width" maxLines={1}
        fontSize={FONT.small} color={textSub()}>{nowLine()}</Text>
      <Show when={r()?.now}>
        <View x={textX} y={ROW_H - 6 - BAR_H - 4} width={textW()} height={BAR_H} color={props.lit ? 0xffffff40 : TRACK}>
          <View width={Math.round(textW() * progressOf(r()?.now, props.now))} height={BAR_H}
            color={props.lit ? COLORS.onFocus : COLORS.focus} />
        </View>
      </Show>
    </View>
  );
}

/**
 * Virtualised channel list. One focusable node handles the keys (passed in by Home); rows are drawn only for
 * the visible window plus 5 rows above and below, positioned by index so scrolling re-uses existing rows.
 *
 * Pointer: the whole list is one target. Hover highlights a row (never focus) and, with `onRowOptions`, shows a `⋯`
 * button at its right end. Clicks, double clicks and right clicks report the row; a wheel step is `onWheelStep`
 * (default `onMove`).
 */
export function ChannelList(props: {
  ref: (el: ElementNode) => void;
  x: number; y: number; width: number; height: number;
  total: number;
  top: number;
  focus: number;
  row: (index: number) => ChannelRow | undefined;
  now: number;
  playingId: string | undefined;
  /** Append the next programme to the now line (Search). */
  showNext?: boolean;
  onFocusChanged?: (focused: boolean) => void;
  onMove: (delta: number) => boolean;
  onPage: (dir: 1 | -1) => boolean;
  onLeft: () => boolean;
  onOk: () => boolean;
  onOptions: () => boolean;
  /** Pointer click on row `index` (`double`: the second click of a double click on the same row). */
  onRowClick?: (index: number, double: boolean) => void;
  /** Right click on a row, or a click on its `⋯` button (the button shows only when this is set). */
  onRowOptions?: (index: number) => void;
  /** One wheel step (default: `onMove`). */
  onWheelStep?: (delta: 1 | -1) => void;
  /** False: the pointer passes over the list (a keyboard is open above it). Default true. */
  pointerEnabled?: boolean;
}) {
  const [focused, setFocused] = createSignal(false);
  const [hoverRow, setHoverRow] = createSignal<number | undefined>(undefined);
  const [hoverDots, setHoverDots] = createSignal(false);
  let node: ElementNode | undefined;
  const viewRows = () => Math.max(1, Math.floor(props.height / ROW_H));
  const indices = createMemo(() => {
    const r = renderRange(props.top, viewRows(), props.total);
    return Array.from({ length: r.to - r.from }, (_, i) => r.from + i);
  });

  const indexAt = (p: Point) => rowAt(p.y, props.top, ROW_H, props.total);
  const onDots = (p: Point) => props.onRowOptions !== undefined && p.x >= props.width - DOTS_W - DOTS_PAD;
  const click = (p: Point, double: boolean) => {
    const i = indexAt(p);
    if (i === undefined) return;
    if (onDots(p)) {
      if (!double) props.onRowOptions?.(i);
      return;
    }
    props.onRowClick?.(i, double);
  };
  usePointerTarget({
    node: () => node,
    enabled: () => props.pointerEnabled !== false,
    onHover: (p) => {
      setHoverRow(p ? indexAt(p) : undefined);
      setHoverDots(p !== undefined && onDots(p));
    },
    onClick: (p) => click(p, false),
    onDoubleClick: (p) => click(p, true),
    // A double click needs both clicks on the same row; a row's `⋯` button is a part of its own.
    subAt: (p) => {
      const i = indexAt(p);
      return i === undefined ? undefined : onDots(p) ? -1 - i : i;
    },
    onContextMenu: (p) => {
      const i = indexAt(p);
      if (i !== undefined) props.onRowOptions?.(i);
    },
    onWheel: (dy) => {
      if (dy !== 0) {
        const d = dy > 0 ? 1 : -1;
        if (props.onWheelStep) props.onWheelStep(d);
        else props.onMove(d);
      }
      return true;
    },
  });
  const hovered = (i: number) => pointerMode() && hoverRow() === i;
  const dotsRow = () => (pointerMode() && props.onRowOptions !== undefined ? hoverRow() : undefined);

  return (
    <View ref={(el) => { node = el; props.ref(el); }} x={props.x} y={props.y} width={props.width} height={props.height} clipping
      onFocusChanged={(f: boolean) => { setFocused(f); props.onFocusChanged?.(f); }}
      onUp={() => props.onMove(-1)} onDown={() => props.onMove(1)}
      onChannelUp={() => props.onPage(-1)} onChannelDown={() => props.onPage(1)}
      onLeft={() => props.onLeft()} onEnter={() => props.onOk()}
      onLongOk={() => props.onOptions()} onMenu={() => props.onOptions()}>
      <For each={indices()}>{(i) => (
        <ChannelRowView y={(i - props.top) * ROW_H} width={props.width} row={props.row(i)}
          lit={i === props.focus && focused()} isFocus={i === props.focus} now={props.now}
          playingId={props.playingId} showNext={props.showNext} hover={hovered(i)} optionsShown={dotsRow() === i} />
      )}</For>
      <Show when={dotsRow() !== undefined}>
        <View x={props.width - DOTS_W - DOTS_PAD} y={((dotsRow() ?? 0) - props.top) * ROW_H + (ROW_H - 6 - DOTS_H) / 2}
          width={DOTS_W} height={DOTS_H} borderRadius={DOTS_H / 2} color={hoverDots() ? COLORS.focus : COLORS.background}>
          <Text y={(DOTS_H - FONT.body) / 2 - 4} width={DOTS_W} maxWidth={DOTS_W} contain="width" textAlign="center"
            fontSize={FONT.body} color={hoverDots() ? COLORS.onFocus : COLORS.text}>{ROW_OPTIONS_LABEL}</Text>
        </View>
      </Show>
    </View>
  );
}
