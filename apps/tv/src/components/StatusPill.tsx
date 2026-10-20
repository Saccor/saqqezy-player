import { For, Show, Text, View } from '@lightningtv/solid';
import { createSignal, onCleanup } from 'solid-js';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { visibleInterval } from '../shell/visibleInterval.ts';

/** The pill's size, shared by the live Player and the VOD player so a status reads the same on both. */
export const STATUS_PILL_W = 460;
export const STATUS_PILL_H = 64;
const SPINNER_W = 36;
const PAD_X = 24;

/** Eight dots, one lit at a time, 120 ms a step. Mounted only while a status shows; sleeps while the page is hidden. */
function Spinner(props: { x: number; y: number }) {
  const [tick, setTick] = createSignal(0);
  onCleanup(visibleInterval(() => setTick((v) => (v + 1) % 8), 120));
  const dots = [0, 1, 2, 3, 4, 5, 6, 7];
  return (
    <View x={props.x} y={props.y} width={SPINNER_W} height={SPINNER_W}>
      <For each={dots}>{(i) => {
        const a = (i / 8) * Math.PI * 2;
        return (
          <View x={15 + Math.cos(a) * 13} y={15 + Math.sin(a) * 13} width={6} height={6} borderRadius={3}
            color={(i - tick() + 8) % 8 === 0 ? COLORS.focus : COLORS.muted} />
        );
      }}</For>
    </View>
  );
}

/**
 * The short stream status ("Loading…", "Reconnecting…") in a pill at the top centre of a player. With `spinner` the
 * text sits right of a spinner; without, it is centred. One line; longer text is clipped at the pill's edge.
 */
export function StatusPill(props: { text: string; spinner?: boolean; zIndex?: number }) {
  const textX = () => (props.spinner ? SPINNER_W + PAD_X + 12 : PAD_X);
  const textW = () => STATUS_PILL_W - textX() - PAD_X;
  return (
    <View x={(LAYOUT.width - STATUS_PILL_W) / 2} y={LAYOUT.safeY} width={STATUS_PILL_W} height={STATUS_PILL_H} color={COLORS.panel}
      borderRadius={STATUS_PILL_H / 2} zIndex={props.zIndex ?? 20}>
      <Show when={props.spinner}>
        <Spinner x={PAD_X - 2} y={(STATUS_PILL_H - SPINNER_W) / 2} />
      </Show>
      <Text x={textX()} y={(STATUS_PILL_H - FONT.body) / 2 - 4} width={textW()} maxWidth={textW()} contain="width" maxLines={1}
        textAlign={props.spinner ? 'left' : 'center'} fontSize={FONT.body} color={COLORS.text}>{props.text}</Text>
    </View>
  );
}
