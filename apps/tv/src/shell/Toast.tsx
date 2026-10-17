import { Show, Text, View } from '@lightningtv/solid';
import { createEffect, createSignal, onCleanup } from 'solid-js';
import { TOAST_OVERLAY_ID, TOAST_W, toastLayout, toastOnExpiry, toastOnShow, type ToastState } from './logic.ts';
import { router } from './router.ts';
import { COLORS, FONT, LAYOUT } from './theme.ts';

export const TOAST_MS = 4000;
/** Default precedence. Only background guide-refresh failures use a lower one (0), so they never interrupt. */
export const TOAST_PRIORITY_NORMAL = 1;

const [state, setState] = createSignal<ToastState>({});
/** The current screen's toast bottom edge (above its own bottom controls), or undefined for the default. */
const [floor, setFloor] = createSignal<number | undefined>(undefined);

/**
 * For a screen whose controls sit above the shell's bottom row (the Player's banner, VodPlay's bar and subtitles):
 * toasts end above `bottom()` while the screen is mounted. Call once in the screen's setup.
 */
export function useToastFloor(bottom: () => number | undefined): void {
  createEffect(() => setFloor(bottom()));
  onCleanup(() => setFloor(undefined));
}
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
      {(t) => {
        const l = () => toastLayout(t(), floor());
        return (
          <View x={(LAYOUT.width - TOAST_W) / 2} y={l().y} width={TOAST_W} height={l().height}
            color={COLORS.surface} borderRadius={Math.min(36, l().height / 2)} zIndex={20}
            border={{ width: 2, color: COLORS.muted }}>
            <Text x={24} y={l().textY} width={TOAST_W - 48} maxWidth={TOAST_W - 48} contain="width" maxLines={l().lines}
              lineHeight={l().lineH} textAlign="center" fontSize={FONT.body} color={COLORS.text}>{`${t()}`}</Text>
          </View>
        );
      }}
    </Show>
  );
}
