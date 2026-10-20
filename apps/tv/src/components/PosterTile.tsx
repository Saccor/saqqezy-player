import { Show, Text, View } from '@lightningtv/solid';
import type { VodTile } from '@iptv/app-api';
import { COLORS, FONT } from '../shell/theme.ts';
import { PosterArt } from '../vod/PosterArt.tsx';

export { posterCache } from './posterCache.ts';

export const POSTER_W = 188;
export const POSTER_H = 282;
export const POSTER_GAP = 24;
const BAR_H = 6;

/**
 * One poster (`PosterArt`): the source's image or a title card, scaled 1.08 with a focus ring when focused (`lit`), a
 * progress bar, a watched check, and the Continue watching badge ("S2 · E4"). `label` draws a text-only tile; no tile
 * and no label is a skeleton (still loading).
 */
export function PosterTile(props: { x: number; y: number; w: number; h: number; tile: VodTile | undefined; lit: boolean; hover?: boolean; label?: string }) {
  const t = () => props.tile;
  return (
    <View x={props.x} y={props.y} width={props.w} height={props.h} scale={props.lit ? 1.08 : 1} zIndex={props.lit ? 2 : 1}>
      <PosterArt w={props.w} h={props.h} title={t()?.title ?? ''} image={t()?.poster} progress={t()?.progress} watched={t()?.watched}
        lit={props.lit} hover={props.hover} label={props.label} pending={!t() && props.label === undefined} titleLines={t()?.badge ? 2 : undefined}>
        <Show when={t()?.badge}>
          <View x={8} y={props.h - BAR_H - 44} width={props.w - 16} height={36} zIndex={4} borderRadius={18} color={0x0b0d12cc}>
            <Text y={6} width={props.w - 16} maxWidth={props.w - 16} contain="width" textAlign="center" fontSize={FONT.small}
              color={COLORS.text}>{t()?.badge ?? ''}</Text>
          </View>
        </Show>
      </PosterArt>
    </View>
  );
}
