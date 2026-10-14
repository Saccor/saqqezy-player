import { Show, Text, View } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { TOAST_OVERLAY_ID, toastOnExpiry, toastOnShow, type ToastState } from './logic.ts';
import { router } from './router.ts';
import { COLORS, FONT, LAYOUT } from './theme.ts';

export const TOAST_MS = 4000;
/** Default precedence. Only background guide-refresh failures use a lower one (0), so they never interrupt. */
export const TOAST_PRIORITY_NORMAL = 1;
const WIDTH = 1100;
const HEIGHT = 72;

const [state, setState] = createSignal<ToastState>({});
const text = () => state().current?.text;
let timer: ReturnType<typeof setTimeout> | undefined;
let removeOverlay: (() => void) | undefined;

function stopTimer(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}

/** Back closed the toast: drop it and anything waiting behind it. */
function clear(): void {
  stopTimer();
  removeOverlay = undefined;
  setState({});
}

/** (Re)starts the 4 s window and the Back layer for the toast now visible. */
function startWindow(): void {
  stopTimer();
  removeOverlay?.();
  removeOverlay = router.pushOverlay(TOAST_OVERLAY_ID, clear);
  timer = setTimeout(expire, TOAST_MS);
}

function expire(): void {
  timer = undefined;
  const next = toastOnExpiry(state());
  setState(next);
  if (next.current) {
    startWindow();
  } else {
    const remove = removeOverlay;
    removeOverlay = undefined;
    remove?.();
  }
}

/**
 * Shows a toast bottom-centre for 4 s. It is an overlay, so Back closes it before leaving the screen. A toast
 * with lower `priority` than the visible one waits until that one's 4 s are up (see `toastOnShow`).
 */
export function showToast(message: string, priority = TOAST_PRIORITY_NORMAL): void {
  const prev = state().current;
  const next = toastOnShow(state(), { text: message, priority });
  setState(next);
  if (next.current !== prev) startWindow();
}

export function Toast() {
  return (
    <Show when={text()}>
      {(t) => (
        <View x={(LAYOUT.width - WIDTH) / 2} y={LAYOUT.height - LAYOUT.safeY - HEIGHT - 24} width={WIDTH} height={HEIGHT}
          color={COLORS.surface} borderRadius={HEIGHT / 2} zIndex={20}
          border={{ width: 2, color: COLORS.muted }}>
          <Text x={24} y={(HEIGHT - FONT.body) / 2 - 4} width={WIDTH - 48} maxWidth={WIDTH - 48} contain="width"
            textAlign="center" fontSize={FONT.body} color={COLORS.text}>{`${t()}`}</Text>
        </View>
      )}
    </Show>
  );
}
