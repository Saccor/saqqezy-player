import { Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal, onMount } from 'solid-js';
import type { ChannelRow } from '@iptv/app-api';
import { COLORS, LAYOUT, LINE, RADIUS, SPACE, STRONG, TYPE } from '../shell/theme.ts';
import { ChannelList, ROW_H } from './ChannelList.tsx';

const W = 900;
const ROWS = 7;

/** The channels in the user's playlist that air one event (spec §4), best first (the worker sorts them). */
export function EventChannels(props: {
  title: string; when: string; rows: ChannelRow[]; now: number; onPick: (channelId: string) => void;
  /** Menu on a row (catch-up: From the start on a row with an archive). */
  onRowMenu?: (channelId: string) => void;
  /** A line under the list (what Menu does). */
  hint?: string;
}) {
  const [focus, setFocus] = createSignal(0);
  const [top, setTop] = createSignal(0);
  let list: ElementNode | undefined;
  const x = (LAYOUT.width - W) / 2;
  const h = ROWS * ROW_H;
  const y = (LAYOUT.height - h - 120) / 2;
  const move = (d: number) => {
    const next = Math.max(0, Math.min(props.rows.length - 1, focus() + d));
    setFocus(next);
    if (next < top()) setTop(next);
    else if (next >= top() + ROWS) setTop(next - ROWS + 1);
    return true;
  };
  const pick = (i: number) => { const r = props.rows[i]; if (r) props.onPick(r.id); return true; };
  onMount(() => queueMicrotask(() => list?.setFocus()));
  return (
    <View x={0} y={0} width={LAYOUT.width} height={LAYOUT.height} color={COLORS.scrim} zIndex={70}>
      <View x={x - 24} y={y - 24} width={W + 48} height={h + 168} color={COLORS.panel} borderRadius={RADIUS.card}>
        <Text x={24} y={SPACE.m} width={W} maxWidth={W} contain="width" maxLines={1} fontSize={TYPE.body} {...STRONG} color={COLORS.text}>{props.title}</Text>
        <Text x={24} y={SPACE.m + LINE.body} fontSize={TYPE.meta} color={COLORS.muted}>{props.when}</Text>
        <Text x={24} y={h + SPACE.xl * 2 + SPACE.l} width={W} maxWidth={W} contain="width" maxLines={1} fontSize={TYPE.meta} color={COLORS.muted}>{props.hint ?? ''}</Text>
      </View>
      <ChannelList ref={(el) => { list = el; }} x={x} y={y + SPACE.xl * 2} width={W} height={h} total={props.rows.length} top={top()} focus={focus()}
        row={(i) => props.rows[i]} now={props.now} playingId={undefined}
        onMove={move} onPage={(d) => move(d * ROWS)} onLeft={() => true}
        onOk={() => pick(focus())} onOptions={() => { const r = props.rows[focus()]; if (r) props.onRowMenu?.(r.id); return true; }}
        onRowClick={(i) => { pick(i); }} />
    </View>
  );
}
