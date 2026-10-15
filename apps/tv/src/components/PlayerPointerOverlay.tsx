import { Show } from '@lightningtv/solid';
import { POINTER_BAR_H, barLayout } from '../input/pointerLogic.ts';
import { PLAYER_POINTER_LABELS as L } from '../screens/playerLogic.ts';
import { LAYOUT } from '../shell/theme.ts';
import { PointerBar, type PointerBarItem } from './PointerBar.tsx';

const GAP = LAYOUT.gap / 2;
const SIDE_W = 160;
const BOTTOM_W = { back: 180, previous: 210, info: 160, options: 200, guide: 170, window: 190 } as const;

/**
 * The Player's pointer overlay: `▲ Ch+` / `▼ Ch−` on the right edge, and a centred bottom row with `← Back`,
 * `⟲ Previous`, `ⓘ Info`, `☰ Options`, `▦ Guide` and `⛶ Window`; there, Back is never under the stream info panel.
 * The Player decides when it is `visible` (pointer mode, no modal open, not idle for 3 s); `onHoverChange` tells it
 * whether the pointer is over a button.
 *
 * The buttons are SCREEN-layer targets, not overlay ones: an overlay target is modal and would keep the wheel, double
 * click and right click from reaching the Player's full-screen target while the overlay is up. Mounted after that
 * target, they win where they are drawn.
 */
export function PlayerPointerOverlay(props: {
  visible: boolean;
  onHoverChange: (over: boolean) => void;
  onBack: () => void;
  onChannelUp: () => void;
  onChannelDown: () => void;
  onPrevious: () => void;
  onInfo: () => void;
  onOptions: () => void;
  onGuide: () => void;
  onWindow: () => void;
  /** Wheel and right click over a button act as over the video (zap, Options). */
  onWheel: (dy: number) => boolean;
  onContextMenu: () => void;
}) {
  const over = { side: false, bottom: false };
  const report = (part: keyof typeof over, v: boolean) => {
    over[part] = v;
    props.onHoverChange(over.side || over.bottom);
  };
  const side: PointerBarItem[] = [
    { id: 'chUp', label: L.channelUp, width: SIDE_W, onPress: () => props.onChannelUp() },
    { id: 'chDown', label: L.channelDown, width: SIDE_W, onPress: () => props.onChannelDown() },
  ];
  const bottom: PointerBarItem[] = [
    { id: 'back', label: L.back, width: BOTTOM_W.back, onPress: () => props.onBack() },
    { id: 'previous', label: L.previous, width: BOTTOM_W.previous, onPress: () => props.onPrevious() },
    { id: 'info', label: L.info, width: BOTTOM_W.info, onPress: () => props.onInfo() },
    { id: 'options', label: L.options, width: BOTTOM_W.options, onPress: () => props.onOptions() },
    { id: 'guide', label: L.guide, width: BOTTOM_W.guide, onPress: () => props.onGuide() },
    { id: 'window', label: L.window, width: BOTTOM_W.window, onPress: () => props.onWindow() },
  ];
  const wheel = (dy: number) => props.onWheel(dy);
  const context = () => props.onContextMenu();
  const sideH = barLayout(side.map(() => POINTER_BAR_H), GAP).total;
  const bottomW = barLayout(bottom.map((b) => b.width ?? 0), GAP).total;
  return (
    <Show when={props.visible}>
      <PointerBar x={LAYOUT.width - LAYOUT.safeX - SIDE_W} y={(LAYOUT.height - sideH) / 2} items={side} gap={GAP} vertical
        layer="screen" zIndex={40} onWheel={wheel} onContextMenu={context} onHoverChange={(v) => report('side', v)} />
      <PointerBar x={(LAYOUT.width - bottomW) / 2} y={LAYOUT.height - LAYOUT.safeY - POINTER_BAR_H} items={bottom} gap={GAP}
        layer="screen" zIndex={40} onWheel={wheel} onContextMenu={context} onHoverChange={(v) => report('bottom', v)} />
    </Show>
  );
}
