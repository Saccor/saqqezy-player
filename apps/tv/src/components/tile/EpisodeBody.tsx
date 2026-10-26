import { Show, Text, View } from '@lightningtv/solid';
import type { EpisodeView } from '@iptv/app-api';
import { COLORS, RADIUS, TYPE } from '../../shell/theme.ts';
import { episodeMeta } from '../../vod/seriesDetailLogic.ts';
import { EP_H, EP_W } from '../tileLogic.ts';

/** Text rows under the still (px below its bottom edge), as computed offsets. */
const META_Y = EP_H + 16;
const TITLE_Y = EP_H + 46;
const PLOT_Y = EP_H + 84;
const SKELETON_META_Y = EP_H + 22;
const SKELETON_TITLE_Y = EP_H + 54;

/** Below an episode still: "E4 · 42 min", the title (1 line), the synopsis (2 lines); skeleton bars while loading. */
export function EpisodeText(props: { ep: EpisodeView | undefined }) {
  return (
    <Show when={props.ep} fallback={
      <View zIndex={1}>
        <View y={SKELETON_META_Y} width={120} height={18} borderRadius={RADIUS.pill(18)} color={COLORS.surface} />
        <View y={SKELETON_TITLE_Y} width={280} height={22} borderRadius={RADIUS.pill(22)} color={COLORS.surface} />
      </View>
    }>{(ep) => (
      <>
        <Text y={META_Y} width={EP_W} maxWidth={EP_W} contain="width" maxLines={1} zIndex={1} fontSize={TYPE.meta} color={COLORS.muted}>{episodeMeta(ep())}</Text>
        <Text y={TITLE_Y} width={EP_W} maxWidth={EP_W} contain="width" maxLines={1} zIndex={1} fontSize={TYPE.body} color={COLORS.text}>{ep().title}</Text>
        <Text y={PLOT_Y} width={EP_W} maxWidth={EP_W} contain="width" maxLines={2} zIndex={1} fontSize={TYPE.meta} color={COLORS.muted}>{ep().plot ?? ''}</Text>
      </>
    )}</Show>
  );
}
