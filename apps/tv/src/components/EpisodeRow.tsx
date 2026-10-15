import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal } from 'solid-js';
import type { EpisodeView } from '@iptv/app-api';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { rawViaDevProxy } from '../net/devProxy.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { barWidth, titleCardColour } from '../vod/posterLogic.ts';
import { cardAt, episodeMeta } from '../vod/seriesDetailLogic.ts';
import { posterCache } from './PosterTile.tsx';
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
const BAR_H = 6;
const RING = 4;

/**
 * One episode card: the 16:9 still, or a generated card (stable colour, the episode title in text) when there is none
 * or it fails. Below it: "E4 · 42 min", the title (1 line) and the synopsis (2 lines). Focused (`lit`): the still is
 * scaled with a focus-coloured ring (an outset fill behind it, so the image never covers it). Watched: a check badge.
 * In progress: a bar at the bottom of the still. Without `ep`: a skeleton card.
 */
export function EpisodeCard(props: { x: number; y: number; ep: EpisodeView | undefined; lit: boolean; hover?: boolean }) {
  const [failedUrl, setFailedUrl] = createSignal<string | undefined>(undefined);
  const ep = () => props.ep;
  const url = () => (ep()?.still && ep()?.still !== failedUrl() ? ep()?.still : undefined);
  const ring = () => (props.lit ? COLORS.focus : props.hover ? COLORS.muted : undefined);
  const ringW = () => (props.lit ? RING : 2);
  return (
    <View x={props.x} y={props.y} width={EP_W} height={EP_ROW_H} zIndex={props.lit ? 2 : 1}>
      <View width={EP_W} height={EP_H} scale={props.lit ? 1.06 : 1} zIndex={1}>
        <Show when={ring()}>
          {(c) => (
            <View x={-ringW()} y={-ringW()} width={EP_W + ringW() * 2} height={EP_H + ringW() * 2} zIndex={0}
              borderRadius={LAYOUT.radius + ringW()} color={c()} />
          )}
        </Show>
        <View width={EP_W} height={EP_H} zIndex={1} borderRadius={LAYOUT.radius}
          color={ep() ? titleCardColour(ep()?.title ?? '') : COLORS.surface} />
        <Show when={ep()}>
          {/* Generated card text, under the image so a loaded still covers it. */}
          <Text x={20} y={EP_H - 96} width={EP_W - 40} maxWidth={EP_W - 40} contain="width" maxLines={2} zIndex={2}
            fontSize={FONT.body} color={COLORS.text}>{ep()?.title ?? ''}</Text>
          <Show when={posterCache.usable(url()) ? url() : undefined} keyed>
            {(u) => {
              posterCache.touch(u);
              return (
                <View width={EP_W} height={EP_H} zIndex={3} borderRadius={LAYOUT.radius} src={rawViaDevProxy(u)}
                  onEvent={{ failed: () => { posterCache.markFailed(u); setFailedUrl(u); } }} />
              );
            }}
          </Show>
          <Show when={ep()?.progress !== undefined && !ep()?.watched}>
            <View y={EP_H - BAR_H} width={EP_W} height={BAR_H} zIndex={4} color={0x000000aa}>
              <View width={barWidth(ep()?.progress, EP_W)} height={BAR_H} color={COLORS.focus} />
            </View>
          </Show>
          <Show when={ep()?.watched}>
            <View x={EP_W - 46} y={12} width={34} height={34} zIndex={4} borderRadius={17} color={0x0b0d12cc}>
              <Text y={4} width={34} maxWidth={34} contain="width" textAlign="center" fontSize={FONT.small} color={COLORS.text}>{'✓'}</Text>
            </View>
          </Show>
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
