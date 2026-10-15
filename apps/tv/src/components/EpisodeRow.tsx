import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal } from 'solid-js';
import type { EpisodeView } from '@iptv/app-api';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { PosterArt } from '../vod/PosterArt.tsx';
import { cardAt, episodeMeta } from '../vod/seriesDetailLogic.ts';
import { renderRange, scrollTopFor } from './virtualWindow.ts';

export const EP_W = 400;
export const EP_H = 225;
export const EP_GAP = 24;
const PITCH = EP_W + EP_GAP;
/** Cards fully in view; the next one peeks in at the right edge. */
export const EP_VISIBLE = 4;
/** The still plus the meta, title and two synopsis lines below it. */
export const EP_ROW_H = EP_H + 150;
/** Cards kept rendered beyond each edge of the visible ones. */
const BUFFER = 3;
/** Skeleton cards while the series loads. */
const SKELETON = 5;

/**
 * One episode card: the 16:9 still or a generated card (`PosterArt`), scaled with a focus ring when focused (`lit`), a
 * watched check, and a progress bar while in progress. Below it: "E4 · 42 min", the title (1 line) and the synopsis
 * (2 lines). Without `ep`: a skeleton card.
 */
export function EpisodeCard(props: { x: number; y: number; ep: EpisodeView | undefined; lit: boolean; hover?: boolean }) {
  const ep = () => props.ep;
  return (
    <View x={props.x} y={props.y} width={EP_W} height={EP_ROW_H} zIndex={props.lit ? 2 : 1}>
      <View width={EP_W} height={EP_H} scale={props.lit ? 1.06 : 1} zIndex={1}>
        <Show when={ep()} fallback={<View width={EP_W} height={EP_H} borderRadius={LAYOUT.radius} color={COLORS.surface} />}>
          <PosterArt w={EP_W} h={EP_H} title={ep()?.title ?? ''} image={ep()?.still} watched={ep()?.watched}
            progress={ep()?.watched ? undefined : ep()?.progress} lit={props.lit} hover={props.hover}
            titleFont={FONT.body} titleLines={2} titleBottom={96} />
        </Show>
      </View>
      <Show when={ep()} fallback={
        <View zIndex={1}>
          <View y={EP_H + 22} width={120} height={18} borderRadius={9} color={COLORS.surface} />
          <View y={EP_H + 54} width={280} height={22} borderRadius={11} color={COLORS.surface} />
        </View>
      }>
        <Text y={EP_H + 16} width={EP_W} maxWidth={EP_W} contain="width" maxLines={1} zIndex={1}
          fontSize={FONT.small} color={COLORS.muted}>{ep() ? episodeMeta(ep()!) : ''}</Text>
        <Text y={EP_H + 46} width={EP_W} maxWidth={EP_W} contain="width" maxLines={1} zIndex={1}
          fontSize={FONT.body} color={COLORS.text}>{ep()?.title ?? ''}</Text>
        <Text y={EP_H + 84} width={EP_W} maxWidth={EP_W} contain="width" maxLines={2} zIndex={1}
          fontSize={FONT.small} color={COLORS.muted}>{ep()?.plot ?? ''}</Text>
      </Show>
    </View>
  );
}

/**
 * One horizontally virtualised row of episode cards (not focusable: the screen owns the keys). The focused card stays in
 * view, moving the row as little as possible. `episodes` undefined: skeleton cards. Pointer: click or right click on a
 * card reports its index.
 */
export function EpisodeRow(props: {
  x: number; y: number; width: number;
  episodes: readonly EpisodeView[] | undefined;
  focusCol: number | undefined;
  lit: boolean;
  onCardClick?: (col: number) => void;
  onCardOptions?: (col: number) => void;
}) {
  const [hover, setHover] = createSignal<number | undefined>(undefined);
  let node: ElementNode | undefined;
  let lastScroll = 0;
  const count = () => (props.episodes ? props.episodes.length : SKELETON);
  const scroll = createMemo(() => {
    if (props.focusCol !== undefined) lastScroll = scrollTopFor(props.focusCol, lastScroll, EP_VISIBLE, count());
    else lastScroll = Math.min(lastScroll, Math.max(0, count() - EP_VISIBLE));
    return lastScroll;
  });
  const cols = createMemo(() => {
    const r = renderRange(scroll(), EP_VISIBLE, count(), BUFFER);
    return Array.from({ length: r.to - r.from }, (_, i) => r.from + i);
  });
  const colAt = (px: number) => (props.episodes ? cardAt(px, scroll(), PITCH, EP_W, props.episodes.length) : undefined);
  usePointerTarget({
    node: () => node,
    onHover: (p) => setHover(p ? colAt(p.x) : undefined),
    subAt: (p) => colAt(p.x),
    onClick: (p) => { const c = colAt(p.x); if (c !== undefined) props.onCardClick?.(c); },
    onContextMenu: (p) => { const c = colAt(p.x); if (c !== undefined) props.onCardOptions?.(c); },
  });
  return (
    <View ref={(el) => { node = el; }} x={props.x} y={props.y} width={props.width} height={EP_ROW_H}>
      <For each={cols()}>{(c) => (
        <EpisodeCard x={(c - scroll()) * PITCH} y={0} ep={props.episodes?.[c]}
          lit={props.lit && props.focusCol === c} hover={pointerMode() && hover() === c} />
      )}</For>
    </View>
  );
}
