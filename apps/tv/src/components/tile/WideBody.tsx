import { Show, Text, View } from '@lightningtv/solid';
import type { ProgrammeHit } from '@iptv/app-api';
import { imageSrc } from '../../images/imageSrc.ts';
import { centerText, COLORS, SPACE, STRONG, TYPE } from '../../shell/theme.ts';
import { progressOf } from '../../screens/homeLogic.ts';
import { COMPACT_W, WIDE_H, WIDE_W, sidesFromKey, sidesKey } from '../wideTileLogic.ts';

const PAD = SPACE.m;
const LOGO = 56;
const TRACK_H = 4;
/** Compact: a smaller pad and logo; the context line on top, then two lines (the sides, or the title), then the detail. */
const C_PAD = 16;
const C_LOGO = 48;
const C_LINE1_Y = 14;
const C_LINE2_Y = 44;
const C_LINE3_Y = 74;
const C_LINE4_Y = 104;

export function FullBody(props: { image: string | undefined; context: string; main: string; onAir: ProgrammeHit | undefined; now: number }) {
  const w = WIDE_W - 2 * PAD;
  const tx = () => (props.image ? LOGO + 14 : 0);
  return (
    <>
      <Show when={props.image} keyed>
        {(u) => <View x={PAD} y={PAD} width={LOGO} height={LOGO} zIndex={2} src={imageSrc(u, LOGO, LOGO)} />}
      </Show>
      <Show when={props.context}>
        <Text x={PAD + tx()} y={PAD + centerText(LOGO, TYPE.meta)} width={w - tx()} maxWidth={w - tx()}
          contain="width" maxLines={1} zIndex={3} fontSize={TYPE.meta} color={COLORS.muted}>{props.context}</Text>
      </Show>
      <Text x={PAD} y={WIDE_H - PAD - TYPE.meta - SPACE.m} width={w} maxWidth={w} contain="width" maxLines={1} zIndex={3}
        fontSize={TYPE.meta} {...STRONG} color={COLORS.text}>{props.main}</Text>
      <Show when={props.onAir} keyed>
        {(p) => (
          <View x={PAD} y={WIDE_H - PAD / 2 - TRACK_H} width={w} height={TRACK_H} zIndex={3} color={COLORS.track}>
            <View width={Math.round(w * progressOf(p, props.now))} height={TRACK_H} color={COLORS.accent} />
          </View>
        )}
      </Show>
    </>
  );
}

export function CompactBody(props: { image: string | undefined; context: string; main: string; sides: [string, string] | undefined; detail: string | undefined; live: boolean; h: number }) {
  const tx = () => C_PAD + (props.image ? C_LOGO + 14 : 0);
  const w = () => COMPACT_W - C_PAD - tx();
  const line = (y: number, text: string, strong: boolean, maxLines = 1) => (
    <Text x={tx()} y={y} width={w()} maxWidth={w()} contain="width" maxLines={maxLines} zIndex={3}
      fontSize={TYPE.meta} {...(strong ? STRONG : {})} color={strong ? COLORS.text : COLORS.muted}>{text}</Text>
  );
  return (
    <>
      <Show when={props.image} keyed>
        {(u) => <View x={C_PAD} y={(props.h - C_LOGO) / 2} width={C_LOGO} height={C_LOGO} zIndex={2} src={imageSrc(u, C_LOGO, C_LOGO)} />}
      </Show>
      <Show when={props.context} fallback={
        // Only the main line (View all): centred in the tile.
        <Text x={tx()} y={centerText(props.h, TYPE.meta)} width={w()} maxWidth={w()} contain="width" maxLines={1} zIndex={3}
          fontSize={TYPE.meta} {...STRONG} color={COLORS.text}>{props.main}</Text>
      }>
        <Text x={tx()} y={C_LINE1_Y} width={w()} maxWidth={w()} contain="width" maxLines={1} zIndex={3}
          fontSize={TYPE.meta} color={props.live ? COLORS.text : COLORS.muted}>{props.context}</Text>
        <Show when={sidesKey(props.sides)} keyed fallback={line(C_LINE2_Y, props.main, true, 2)}>
          {(k) => {
            const [a, b] = sidesFromKey(k);
            return <>{line(C_LINE2_Y, a, true)}{line(C_LINE3_Y, b, true)}</>;
          }}
        </Show>
        <Show when={props.detail}>{line(C_LINE4_Y, props.detail ?? '', false)}</Show>
      </Show>
    </>
  );
}
