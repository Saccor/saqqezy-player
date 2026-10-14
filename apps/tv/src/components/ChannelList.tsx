import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal } from 'solid-js';
import type { ChannelRow } from '@iptv/app-api';
import { rawViaDevProxy } from '../net/devProxy.ts';
import { formatRange, progressOf } from '../screens/homeLogic.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { logoCache } from './logoCache.ts';
import { renderRange } from './virtualWindow.ts';

export const ROW_H = 84;
const NUM_W = 76;
const LOGO_W = 104;
const LOGO_H = 60;
const BAR_H = 4;
const ROW_FOCUS_FILL = COLORS.focus;
const TRACK = 0x2a3140ff;

function Logo(props: { x: number; y: number; url: string | undefined; number: number; focused: boolean }) {
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

/**
 * Virtualised channel list. One focusable node handles the keys (passed in by Home); rows are drawn only for
 * the visible window plus 5 rows above and below, positioned by index so scrolling re-uses existing rows.
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
}) {
  const [focused, setFocused] = createSignal(false);
  const viewRows = () => Math.max(1, Math.floor(props.height / ROW_H));
  const indices = createMemo(() => {
    const r = renderRange(props.top, viewRows(), props.total);
    return Array.from({ length: r.to - r.from }, (_, i) => r.from + i);
  });

  return (
    <View ref={props.ref} x={props.x} y={props.y} width={props.width} height={props.height} clipping
      onFocusChanged={(f: boolean) => { setFocused(f); props.onFocusChanged?.(f); }}
      onUp={() => props.onMove(-1)} onDown={() => props.onMove(1)}
      onChannelUp={() => props.onPage(-1)} onChannelDown={() => props.onPage(1)}
      onLeft={() => props.onLeft()} onEnter={() => props.onOk()}
      onLongOk={() => props.onOptions()} onMenu={() => props.onOptions()}>
      <For each={indices()}>{(i) => {
        const r = () => props.row(i);
        const isFocus = () => i === props.focus;
        const lit = () => isFocus() && focused();
        const fill = () => (lit() ? ROW_FOCUS_FILL : isFocus() ? COLORS.surface : 0x00000000);
        const textMain = () => (lit() ? COLORS.onFocus : COLORS.text);
        const textSub = () => (lit() ? 0xffffffcc : COLORS.muted);
        const textX = NUM_W + LOGO_W + 20;
        const textW = props.width - textX - 20;
        const nowLine = () => {
          const n = r()?.now;
          const nx = props.showNext ? r()?.next : undefined;
          if (!n) return r() ? 'No guide information' : '';
          return `${formatRange(n.start, n.stop)} · ${n.title}${nx ? `  |  Next: ${nx.title}` : ''}`;
        };
        return (
          <View x={0} y={(i - props.top) * ROW_H} width={props.width} height={ROW_H - 6} color={fill()}
            borderRadius={LAYOUT.radius}>
            <Text x={12} y={(ROW_H - 6 - FONT.body) / 2 - 3} width={NUM_W - 16} maxWidth={NUM_W - 16} contain="width"
              textAlign="right" fontSize={FONT.body} color={textSub()}>{`${r()?.number ?? ''}`}</Text>
            <Show when={r()} keyed>
              {(row) => <Logo x={NUM_W} y={(ROW_H - 6 - LOGO_H) / 2} url={row.logo} number={row.number} focused={lit()} />}
            </Show>
            <Text x={textX} y={8} width={textW} maxWidth={textW} contain="width" maxLines={1}
              fontSize={FONT.body} color={textMain()}>
              {`${r()?.name ?? 'Loading…'}${r()?.id === props.playingId && r() ? ' ▶' : ''}`}
            </Text>
            <Text x={textX} y={42} width={textW} maxWidth={textW} contain="width" maxLines={1}
              fontSize={FONT.small} color={textSub()}>{nowLine()}</Text>
            <Show when={r()?.now}>
              <View x={textX} y={ROW_H - 6 - BAR_H - 4} width={textW} height={BAR_H} color={lit() ? 0xffffff40 : TRACK}>
                <View width={Math.round(textW * progressOf(r()?.now, props.now))} height={BAR_H}
                  color={lit() ? COLORS.onFocus : COLORS.focus} />
              </View>
            </Show>
          </View>
        );
      }}</For>
    </View>
  );
}
