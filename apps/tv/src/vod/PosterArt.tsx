import { Show, Text, View } from '@lightningtv/solid';
import { createSignal, type JSX } from 'solid-js';
import { FocusRing } from '../components/FocusRing.tsx';
import { posterCache } from '../components/posterCache.ts';
import { rawViaDevProxy } from '../net/devProxy.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { barWidth, posterFace, titleCardColour } from './posterLogic.ts';

const BAR_H = 6;

/**
 * The art of a poster or an episode still, filling a `w`×`h` box at 0,0 of its parent: the source's image, or a
 * generated title card (stable colour, the title in text) when there is none or it fails; a skeleton (a plain surface
 * card) while the image or the tile itself (`pending`) is on the way. Focused (`lit`): the shared FocusRing (a light ring
 * outside a dark gap; hover: a thin muted ring), an outset fill behind the card so the image never covers it.
 * `progress`: a bar at the bottom. `watched`: a check badge. `label`: a text-only card (View all, Loading…).
 * Children are extra overlays (zIndex 4 sits above the image). Layered by zIndex: a late-loading image would otherwise
 * be inserted on top of the overlays.
 */
export function PosterArt(props: {
  w: number; h: number;
  title: string;
  image?: string;
  progress?: number;
  watched?: boolean;
  lit: boolean;
  hover?: boolean;
  label?: string;
  /** The tile itself is not here yet (a grid page or a row still loading): a skeleton card. */
  pending?: boolean;
  /** The title card text: font size, line count and top edge (default: small, 3 lines, 110 above the bottom). */
  titleFont?: number;
  titleLines?: number;
  titleBottom?: number;
  children?: JSX.Element;
}) {
  const [failedUrl, setFailedUrl] = createSignal<string | undefined>(undefined);
  const [loadedUrl, setLoadedUrl] = createSignal<string | undefined>(undefined);
  const url = () => (props.image && props.image !== failedUrl() ? props.image : undefined);
  /** The image drawn (a URL that failed before, in this or another tile, is not tried again). */
  const shown = () => (posterCache.usable(url()) ? url() : undefined);
  const face = () => posterFace({ pending: props.pending === true, image: shown(), loaded: shown() !== undefined && loadedUrl() === shown(), failed: false });
  return (
    <View width={props.w} height={props.h}>
      <FocusRing w={props.w} h={props.h} radius={LAYOUT.radius} lit={props.lit} hover={props.hover} />
      <View width={props.w} height={props.h} zIndex={1} borderRadius={LAYOUT.radius}
        color={props.label !== undefined ? (props.lit ? COLORS.focus : COLORS.surface) : face() === 'card' ? titleCardColour(props.title) : COLORS.surface} />
      <Show when={props.label !== undefined}>
        <Text x={12} y={props.h / 2 - FONT.body} width={props.w - 24} maxWidth={props.w - 24} contain="width" textAlign="center" maxLines={3}
          zIndex={2} fontSize={FONT.body} color={props.lit ? COLORS.onFocus : COLORS.text}>{props.label ?? ''}</Text>
      </Show>
      <Show when={props.label === undefined}>
        {/* Title card text: only on the card (no poster, or it failed), never on a skeleton. */}
        <Text alpha={face() === 'card' ? 1 : 0} x={14} y={props.h - (props.titleBottom ?? 110)} width={props.w - 28} maxWidth={props.w - 28} contain="width"
          maxLines={props.titleLines ?? 3} zIndex={2} fontSize={props.titleFont ?? FONT.small} color={COLORS.text}>{props.title}</Text>
        <Show when={props.pending ? undefined : shown()} keyed>
          {(u) => {
            posterCache.touch(u);
            return (
              <View width={props.w} height={props.h} zIndex={3} borderRadius={LAYOUT.radius} src={rawViaDevProxy(u)}
                onEvent={{ loaded: () => setLoadedUrl(u), failed: () => { posterCache.markFailed(u); setFailedUrl(u); } }} />
            );
          }}
        </Show>
        <Show when={props.progress !== undefined}>
          <View y={props.h - BAR_H} width={props.w} height={BAR_H} zIndex={4} color={0x000000aa}>
            <View width={barWidth(props.progress, props.w)} height={BAR_H} color={COLORS.accent} />
          </View>
        </Show>
        <Show when={props.watched}>
          <View x={props.w - 44} y={10} width={34} height={34} zIndex={4} borderRadius={17} color={0x0b0d12cc}>
            <Text y={4} width={34} maxWidth={34} contain="width" textAlign="center" fontSize={FONT.small} color={COLORS.text}>{'✓'}</Text>
          </View>
        </Show>
        {props.children}
      </Show>
    </View>
  );
}
