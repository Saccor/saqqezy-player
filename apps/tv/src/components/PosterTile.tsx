import { View, type ElementNode } from '@lightningtv/solid';
import type { VodTile } from '@iptv/app-api';
import { useFocusScale } from '../shell/motion.ts';
import { TYPE } from '../shell/theme.ts';
import { PosterArt } from '../vod/PosterArt.tsx';

export { posterCache } from './posterCache.ts';

export { POSTER_GAP, POSTER_H, POSTER_W } from '../vod/posterLogic.ts';

/**
 * One poster: the source's image or a title card, scaled up with the focus ring when focused (`lit`). At most one
 * overlay, the progress bar (spec §1.3): watched and "S2 · E4" live in the info strip's meta line instead. `label`
 * draws a text-only tile; no tile and no label is a skeleton (still loading).
 */
export function PosterTile(props: { x: number; y: number; w: number; h: number; tile: VodTile | undefined; lit: boolean; hover?: boolean; label?: string }) {
  const t = () => props.tile;
  let node: ElementNode | undefined;
  // The scale is owned by the motion helper (animated, interruptible), never bound as a prop.
  useFocusScale(() => node, () => props.lit);
  return (
    <View ref={(el) => { node = el; }} x={props.x} y={props.y} width={props.w} height={props.h} zIndex={props.lit ? 2 : 1}>
      <PosterArt w={props.w} h={props.h} title={t()?.title ?? ''} image={t()?.poster} progress={t()?.progress}
        lit={props.lit} hover={props.hover} label={props.label} pending={!t() && props.label === undefined} titleLines={2} titleFont={TYPE.body} />
    </View>
  );
}
