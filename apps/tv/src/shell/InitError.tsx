import { Text, View, type ElementNode } from '@lightningtv/solid';
import { onMount } from 'solid-js';
import { Button } from '../components/Button.tsx';
import { COLORS, FONT, LAYOUT } from './theme.ts';

const BTN_W = 240;

/** Full-screen state when saved data could not be loaded at startup (error or 10 s timeout). */
export function InitError(props: { onRetry: () => void }) {
  let retry: ElementNode | undefined;
  onMount(() => retry?.setFocus());
  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.background}>
      <Text x={0} y={380} width={LAYOUT.width} maxWidth={LAYOUT.width} contain="width" textAlign="center"
        fontSize={FONT.title} color={COLORS.text}>{"Couldn't load your saved data"}</Text>
      <Text x={0} y={470} width={LAYOUT.width} maxWidth={LAYOUT.width} contain="width" textAlign="center"
        fontSize={FONT.body} color={COLORS.muted}>{'Your sources are still saved on this device. Try again.'}</Text>
      <Button ref={(el) => { retry = el; }} x={(LAYOUT.width - BTN_W) / 2} y={580} width={BTN_W} label="Retry"
        onPress={props.onRetry} />
    </View>
  );
}
