import { Show, Text, View } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import type { VodTile } from '@iptv/app-api';
import { rawViaDevProxy } from '../net/devProxy.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { barWidth, titleCardColour } from '../vod/posterLogic.ts';
import { LogoCache } from './logoCache.ts';

export const POSTER_W = 188;
export const POSTER_H = 282;
export const POSTER_GAP = 24;
/** Failed poster URLs are remembered (a title card is drawn instead of retrying on every scroll). */
export const posterCache = new LogoCache(500);
const BAR_H = 6;
const RING = 4;

/**
 * One poster: the source's image, or a title card (stable colour, the title in text) when there is none or it fails.
 * Focused (`lit`): scaled 1.08 with a focus-coloured ring. In progress: a bar at the bottom. Watched: a check badge.
 * `label` draws a text-only tile (View all, Loading…).
 */
export function PosterTile(props: { x: number; y: number; w: number; h: number; tile: VodTile | undefined; lit: boolean; hover?: boolean; label?: string }) {
  const [failedUrl, setFailedUrl] = createSignal<string | undefined>(undefined);
  const t = () => props.tile;
  const url = () => (t()?.poster && t()?.poster !== failedUrl() ? t()?.poster : undefined);
  return (
    <View x={props.x} y={props.y} width={props.w} height={props.h} scale={props.lit ? 1.08 : 1} zIndex={props.lit ? 2 : 1}
      borderRadius={LAYOUT.radius} color={props.label !== undefined ? (props.lit ? COLORS.focus : COLORS.surface) : titleCardColour(t()?.title ?? '')}
      border={props.lit ? { width: RING, color: COLORS.focus } : props.hover ? { width: 2, color: COLORS.muted } : { width: RING, color: 0x00000000 }}>
      <Show when={props.label !== undefined}>
        <Text x={12} y={props.h / 2 - FONT.body} width={props.w - 24} maxWidth={props.w - 24} contain="width" textAlign="center" maxLines={3}
          fontSize={FONT.body} color={props.lit ? COLORS.onFocus : COLORS.text}>{props.label ?? ''}</Text>
      </Show>
      <Show when={props.label === undefined}>
        {/* Title card text, under the image so a loaded poster covers it. */}
        <Text x={14} y={props.h - 110} width={props.w - 28} maxWidth={props.w - 28} contain="width" maxLines={3}
          fontSize={FONT.small} color={COLORS.text}>{t()?.title ?? ''}</Text>
        <Show when={posterCache.usable(url()) ? url() : undefined} keyed>
          {(u) => {
            posterCache.touch(u);
            return (
              <View width={props.w} height={props.h} borderRadius={LAYOUT.radius} src={rawViaDevProxy(u)}
                onEvent={{ failed: () => { posterCache.markFailed(u); setFailedUrl(u); } }} />
            );
          }}
        </Show>
        <Show when={t()?.progress !== undefined}>
          <View y={props.h - BAR_H} width={props.w} height={BAR_H} color={0x000000aa}>
            <View width={barWidth(t()?.progress, props.w)} height={BAR_H} color={COLORS.focus} />
          </View>
        </Show>
        <Show when={t()?.watched}>
          <View x={props.w - 44} y={10} width={34} height={34} borderRadius={17} color={0x0b0d12cc}>
            <Text y={4} width={34} maxWidth={34} contain="width" textAlign="center" fontSize={FONT.small} color={COLORS.text}>{'✓'}</Text>
          </View>
        </Show>
        <Show when={t()?.badge}>
          <View x={8} y={props.h - BAR_H - 44} width={props.w - 16} height={36} borderRadius={18} color={0x0b0d12cc}>
            <Text y={6} width={props.w - 16} maxWidth={props.w - 16} contain="width" textAlign="center" fontSize={FONT.small}
              color={COLORS.text}>{t()?.badge ?? ''}</Text>
          </View>
        </Show>
      </Show>
    </View>
  );
}
