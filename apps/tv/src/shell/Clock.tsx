import { Text } from '@lightningtv/solid';
import { createSignal, onCleanup } from 'solid-js';
import { formatClock, msToNextMinute } from './logic.ts';
import { COLORS, FONT, LAYOUT } from './theme.ts';

const WIDTH = 120;

/** HH:MM, top-right inside the safe area; re-renders on each minute boundary. */
export function Clock(props: { x?: number; y?: number; width?: number; align?: 'left' | 'center' | 'right'; size?: number }) {
  const [now, setNow] = createSignal(formatClock(new Date()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    const d = new Date();
    setNow(formatClock(d));
    timer = setTimeout(tick, msToNextMinute(d));
  };
  timer = setTimeout(tick, msToNextMinute(new Date()));
  onCleanup(() => clearTimeout(timer));

  return (
    <Text x={props.x ?? LAYOUT.width - LAYOUT.safeX - WIDTH} y={props.y ?? LAYOUT.safeY} width={props.width ?? WIDTH} maxWidth={props.width ?? WIDTH} contain="width"
      textAlign={props.align ?? 'right'} fontSize={props.size ?? FONT.heading} color={COLORS.text} zIndex={10}>{`${now()}`}</Text>
  );
}
