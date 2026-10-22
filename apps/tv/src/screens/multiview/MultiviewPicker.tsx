import { Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal, onMount } from 'solid-js';
import { GROUP_ALL, GROUP_FAV } from '@iptv/core';
import type { ChannelRow } from '@iptv/app-api';
import { api } from '../../api.ts';
import { ChannelList, ROW_H } from '../../components/ChannelList.tsx';
import { MULTIVIEW_COPY } from '../../copy.ts';
import { COLORS, LAYOUT, STRONG, TYPE } from '../../shell/theme.ts';

/** The picker's panel (spec 2026-10-20-multiview §2.3): 560 px on the right, over the dimmed windows. */
export const PICKER_W = 560;
const PAD = 16;
const HEAD = 96;
const LIST_H = Math.floor((LAYOUT.height - HEAD - LAYOUT.safeY) / ROW_H) * ROW_H;
const ROWS = LIST_H / ROW_H;
const CHUNK = 40;

/**
 * Chooses a channel for a window. Favourites when there are some, else all channels. A highlighted row opens nothing:
 * only OK (or a click) picks, so browsing never costs a connection. Rows already in a window say "On screen".
 * Back is the screen's (the picker is registered as an overlay there).
 */
export function MultiviewPicker(props: {
  ref: (el: ElementNode) => void;
  title: string;
  now: number;
  onScreen: (channelId: string) => boolean;
  onPick: (channelId: string) => void;
}) {
  const [group, setGroup] = createSignal(GROUP_ALL);
  const [total, setTotal] = createSignal(0);
  const [rows, setRows] = createSignal<ReadonlyMap<number, ChannelRow>>(new Map());
  const [focus, setFocus] = createSignal(0);
  const [top, setTop] = createSignal(0);
  const asked = new Set<number>();
  let list: ElementNode | undefined;

  const load = (index: number) => {
    const start = Math.max(0, Math.floor(index / CHUNK) * CHUNK);
    if (asked.has(start)) return;
    asked.add(start);
    api.getChannelSlice(group(), start, CHUNK).then(({ total: t, rows: got }) => {
      setTotal(t);
      setRows((m) => {
        const next = new Map(m);
        got.forEach((r, k) => next.set(start + k, r));
        return next;
      });
    }).catch(() => { asked.delete(start); });
  };
  const row = (i: number) => {
    const r = rows().get(i);
    if (!r) load(i);
    return r;
  };
  const move = (d: number) => {
    const next = Math.max(0, Math.min(total() - 1, focus() + d));
    setFocus(next);
    if (next < top()) setTop(next);
    else if (next >= top() + ROWS) setTop(next - ROWS + 1);
    return true;
  };
  const pick = (i: number) => {
    const r = rows().get(i);
    if (r) props.onPick(r.id);
    return true;
  };

  onMount(() => {
    api.getGroups().then((groups) => {
      const fav = groups.find((g) => g.id === GROUP_FAV);
      if (fav && fav.count > 0) setGroup(GROUP_FAV);
      load(0);
    }).catch(() => load(0));
    queueMicrotask(() => list?.setFocus());
  });

  const x = LAYOUT.width - PICKER_W;
  return (
    <View x={0} y={0} width={LAYOUT.width} height={LAYOUT.height} zIndex={60}>
      {/* The windows keep playing behind, dimmed. */}
      <View x={0} y={0} width={x} height={LAYOUT.height} color={COLORS.scrim} />
      <View x={x} y={0} width={PICKER_W} height={LAYOUT.height} color={COLORS.panel}>
        <Text x={PAD + 8} y={36} width={PICKER_W - PAD * 2} maxWidth={PICKER_W - PAD * 2} contain="width" maxLines={1}
          fontSize={TYPE.body} {...STRONG} color={COLORS.text}>{props.title}</Text>
      </View>
      <ChannelList ref={(el) => { list = el; props.ref(el); }} x={x + PAD} y={HEAD} width={PICKER_W - PAD * 2} height={LIST_H}
        total={total()} top={top()} focus={focus()} row={row} now={props.now} playingId={undefined}
        tag={(i) => { const r = rows().get(i); return r && props.onScreen(r.id) ? MULTIVIEW_COPY.onScreen : undefined; }}
        onMove={move} onPage={(d) => move(d * ROWS)} onLeft={() => true}
        onOk={() => pick(focus())} onOptions={() => true}
        onRowClick={(i) => { setFocus(i); pick(i); }} />
    </View>
  );
}
