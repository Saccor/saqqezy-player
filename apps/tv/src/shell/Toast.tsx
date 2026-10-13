import { Show, Text, View } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { router } from './router.ts';
import { COLORS, FONT, LAYOUT } from './theme.ts';

export const TOAST_MS = 4000;
const WIDTH = 1100;
const HEIGHT = 72;

const [text, setText] = createSignal<string | undefined>(undefined);
let timer: ReturnType<typeof setTimeout> | undefined;
let removeOverlay: (() => void) | undefined;

function clear(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  removeOverlay = undefined;
  setText(undefined);
}

/** Shows a toast bottom-centre for 4 s. It is an overlay, so Back closes it before leaving the screen. */
export function showToast(message: string): void {
  if (timer !== undefined) clearTimeout(timer);
  removeOverlay?.();
  setText(message);
  removeOverlay = router.pushOverlay('toast', clear);
  timer = setTimeout(() => {
    const remove = removeOverlay;
    clear();
    remove?.();
  }, TOAST_MS);
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
