import { View } from '@lightningtv/solid';
import { posterCache } from '../components/posterCache.ts';
import { dwellSignal } from '../shell/dwell.ts';
import { BACKGROUND_RGB, LAYOUT, MOTION } from '../shell/theme.ts';
import { platformId } from '../state/appState.ts';
import { isTvPlatform } from '../video/engineConfig.ts';
import { CrossFadeArt } from './CrossFadeArt.tsx';
import { scrimTexture } from './scrim.ts';

/** Art boxes: behind the info strip (Start, browse) and on Details. The art bleeds to the top and right edges. */
const AREAS = {
  strip: { x: 820, w: 1100, h: 560, fade: 280 },
  detail: { x: 620, w: 1300, h: 760, fade: 380 },
} as const;

/**
 * Right-aligned art from the source's data only, faded into the background on its left and bottom; a new image
 * cross-fades in. No art: nothing (a flat background, never a placeholder). Place it first; it takes zIndex 0 and 1.
 */
export function Backdrop(props: { url: string | undefined; area: keyof typeof AREAS }) {
  const a = () => AREAS[props.area];
  // TVs: the strip art follows focus only once it has rested a while longer (MOTION.backdropDwellTv). Details keeps its
  // art at once.
  const url = props.area === 'strip' && isTvPlatform(platformId) ? dwellSignal(() => props.url, MOTION.backdropDwellTv) : () => props.url;
  return (
    <>
      <View zIndex={0}>
        <CrossFadeArt x={a().x} y={0} width={a().w} height={a().h} url={url() && posterCache.usable(url()) ? url() : undefined}
          onFailed={(u) => posterCache.markFailed(u)} />
      </View>
      <View zIndex={1} x={a().x} y={0} width={a().w} height={a().h} src={scrimTexture('left', BACKGROUND_RGB)} />
      <View zIndex={1} y={a().h - a().fade} width={LAYOUT.width} height={a().fade} src={scrimTexture('down', BACKGROUND_RGB)} />
    </>
  );
}
