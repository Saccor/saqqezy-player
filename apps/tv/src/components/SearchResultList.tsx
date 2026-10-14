import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal } from 'solid-js';
import { dayLabel } from '../screens/guideLogic.ts';
import { formatRange, progressOf } from '../screens/homeLogic.ts';
import type { SearchRow } from '../screens/searchLogic.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { BAR_H, ChannelRowView, LOGO_H_PX, LOGO_W_PX, Logo, NUM_W_PX, ROW_FOCUS_FILL, ROW_H, TRACK } from './ChannelList.tsx';
import { renderRange } from './virtualWindow.ts';

/** A programme row: title on top, "when · channel" below, progress while on air. */
function ProgrammeRowView(props: {
  y: number; width: number; row: Extract<SearchRow, { kind: 'onNow' | 'later' }>; lit: boolean; isFocus: boolean; now: number;
}) {
  const fill = () => (props.lit ? ROW_FOCUS_FILL : props.isFocus ? COLORS.surface : 0x00000000);
  const textMain = () => (props.lit ? COLORS.onFocus : COLORS.text);
  const textSub = () => (props.lit ? 0xffffffcc : COLORS.muted);
  const textX = NUM_W_PX + LOGO_W_PX + 20;
  const textW = props.width - textX - 20;
  const hit = () => props.row.hit;
  const title = () => hit().title;
  const sub = () => {
    const h = hit();
    const ch = `${h.channel.number} ${h.channel.name}`;
    if (props.row.kind === 'onNow') return `${formatRange(h.start, h.stop)} · ${ch}`;
    const more = (h as { more: number }).more;
    return `${dayLabel(h.start, props.now)} ${formatRange(h.start, h.stop)} · ${ch}${more > 0 ? ` · +${more} more` : ''}`;
  };
  return (
    <View x={0} y={props.y} width={props.width} height={ROW_H - 6} color={fill()} borderRadius={LAYOUT.radius}>
      <Logo x={NUM_W_PX} y={(ROW_H - 6 - LOGO_H_PX) / 2} url={hit().channel.logo} number={hit().channel.number} focused={props.lit} />
      <Text x={textX} y={8} width={textW} maxWidth={textW} contain="width" maxLines={1} fontSize={FONT.body} color={textMain()}>{title()}</Text>
      <Text x={textX} y={42} width={textW} maxWidth={textW} contain="width" maxLines={1} fontSize={FONT.small} color={textSub()}>{sub()}</Text>
      <Show when={props.row.kind === 'onNow'}>
        <View x={textX} y={ROW_H - 6 - BAR_H - 4} width={textW} height={BAR_H} color={props.lit ? 0xffffff40 : TRACK}>
          <View width={Math.round(textW * progressOf(hit(), props.now))} height={BAR_H} color={props.lit ? COLORS.onFocus : COLORS.focus} />
        </View>
      </Show>
    </View>
  );
}

/**
 * Virtualised search results: section headers, channel rows, programme rows and a trailing note. One focusable
 * node handles the keys; the caller keeps focus on selectable rows.
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
}) {
  const [focused, setFocused] = createSignal(false);
  const viewRows = () => Math.max(1, Math.floor(props.height / ROW_H));
  const indices = createMemo(() => {
    const r = renderRange(props.top, viewRows(), props.rows.length);
    return Array.from({ length: r.to - r.from }, (_, i) => r.from + i);
  });
  return (
    <View ref={props.ref} x={props.x} y={props.y} width={props.width} height={props.height} clipping
      onFocusChanged={(f: boolean) => setFocused(f)}
      onUp={() => props.onMove(-1)} onDown={() => props.onMove(1)}
      onChannelUp={() => props.onPage(-1)} onChannelDown={() => props.onPage(1)}
      onLeft={() => props.onLeft()} onEnter={() => props.onOk()}>
      <For each={indices()}>{(i) => {
        const r = () => props.rows[i];
        const y = () => (i - props.top) * ROW_H;
        const lit = () => i === props.focus && focused();
        const isFocus = () => i === props.focus;
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
                now={props.now} playingId={props.playingId} showNext />;
            }
            return <ProgrammeRowView y={y()} width={props.width} row={row} lit={lit()} isFocus={isFocus()} now={props.now} />;
          }}</Show>
        );
      }}</For>
    </View>
  );
}
