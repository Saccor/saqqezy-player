import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import type { VodHome } from '@iptv/app-api';
import { Button } from '../../components/Button.tsx';
import { INFO_STRIP } from '../../components/infoBlockLogic.ts';
import { COMMON_COPY } from '../../copy.ts';
import { COLORS, LAYOUT, RADIUS, TYPE } from '../../shell/theme.ts';
import { skeletonShown, type skeletonRows } from '../../vod/browseLogic.ts';

/**
 * Movies or Series browse while it has no rows to show: the status line (loading, empty, the error), skeleton rows on
 * the first load, and Try again after an error.
 */
export function BrowseStatus(props: {
  /** The rows' x and y (the skeletons and the button sit where the rows go). */
  x: number;
  y: number;
  status: VodHome['status'] | undefined;
  message: string;
  rowCount: number;
  /** The skeleton rows drawn on the first load (`skeletonRows`). */
  skeletons: ReturnType<typeof skeletonRows>;
  errorRef: (el: ElementNode) => void;
  onLeft: () => boolean;
  onRetry: () => void;
  onRetryUp: () => boolean;
}) {
  return (
    <View zIndex={2} onLeft={props.onLeft}>
      <Text x={props.x} y={INFO_STRIP.y} width={LAYOUT.contentW} maxWidth={LAYOUT.contentW} contain="width" maxLines={2}
        fontSize={TYPE.title} color={COLORS.text}>{props.message}</Text>
      {/* First load: skeleton rows (a label bar and poster placeholders) stand in for the rows (spec §3.7). */}
      <Show when={skeletonShown(props.status, props.rowCount)}>
        <For each={props.skeletons}>{(r) => (
          <View>
            <View x={r.label.x} y={r.label.y} width={r.label.w} height={r.label.h} borderRadius={r.label.h / 2} color={COLORS.surface} />
            <For each={r.posters}>{(p) => <View x={p.x} y={p.y} width={p.w} height={p.h} borderRadius={RADIUS.card} color={COLORS.surface} />}</For>
          </View>
        )}</For>
      </Show>
      <Show when={props.status === 'error'}>
        <Button ref={props.errorRef} x={props.x} y={props.y} label={COMMON_COPY.tryAgain}
          onPress={props.onRetry} onUp={props.onRetryUp} />
      </Show>
    </View>
  );
}
