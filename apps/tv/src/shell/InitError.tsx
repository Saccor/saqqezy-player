import { Text, View, type ElementNode } from '@lightningtv/solid';
import { onMount } from 'solid-js';
import { Button } from '../components/Button.tsx';
import { COMMON_COPY, SHELL_COPY } from '../copy.ts';
import { COLORS, LAYOUT, LINE, SPACE, TYPE } from './theme.ts';

const BTN_W = 240;

/** Full-screen state when saved data could not be loaded at startup (error or 10 s timeout). */
export function InitError(props: { onRetry: () => void }) {
  let retry: ElementNode | undefined;
  onMount(() => retry?.setFocus());
  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.background}>
      <Text x={0} y={SPACE.xl * 8} width={LAYOUT.width} maxWidth={LAYOUT.width} contain="width" textAlign="center"
        fontSize={TYPE.title} color={COLORS.text}>{SHELL_COPY.initError.title}</Text>
      <Text x={0} y={SPACE.xl * 8 + LINE.title + SPACE.m} width={LAYOUT.width} maxWidth={LAYOUT.width} contain="width" textAlign="center"
        fontSize={TYPE.body} color={COLORS.muted}>{SHELL_COPY.initError.body}</Text>
      <Button ref={(el) => { retry = el; }} x={(LAYOUT.width - BTN_W) / 2} y={SPACE.xl * 8 + LINE.title + SPACE.m + LINE.body + SPACE.xl + SPACE.l} width={BTN_W} label={COMMON_COPY.tryAgain}
        onPress={props.onRetry} />
    </View>
  );
}
