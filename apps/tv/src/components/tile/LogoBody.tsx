import { Show, Text, View } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { imageSrc } from '../../images/imageSrc.ts';
import { monogram } from '../../screens/guideLogic.ts';
import { COLORS, RADIUS, STRONG, TYPE, centerText } from '../../shell/theme.ts';
import { logoCache } from '../logoCache.ts';
import { logoKey } from '../logoKey.ts';

/** A channel logo from the user's own data, or a tile with two initials when there is none (CLAUDE.md rule 4). */
export function LogoBody(props: { url: string | undefined; name: string; size: number }) {
  const [failedUrl, setFailedUrl] = createSignal<string | undefined>(undefined);
  const key = () => logoKey(props.url, failedUrl(), (u) => logoCache.usable(u));
  return (
    <View width={props.size} height={props.size} zIndex={1} borderRadius={RADIUS.card} color={COLORS.surfaceRaised}>
      <Show when={key() === undefined}>
        <Text y={centerText(props.size, TYPE.title)} width={props.size} maxWidth={props.size} contain="width" textAlign="center" maxLines={1}
          fontSize={TYPE.title} color={COLORS.muted} {...STRONG}>{monogram(props.name)}</Text>
      </Show>
      <Show when={key()} keyed>{(url) => {
        logoCache.touch(url);
        return (
          <View width={props.size} height={props.size} borderRadius={RADIUS.card} src={imageSrc(url, props.size, props.size)}
            onEvent={{ failed: () => { logoCache.markFailed(url); setFailedUrl(url); } }} />
        );
      }}</Show>
    </View>
  );
}
