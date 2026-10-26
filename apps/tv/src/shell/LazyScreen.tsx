import { Show, Text, View, activeElement, type ElementNode } from '@lightningtv/solid';
import { createComponent, createSignal, onCleanup, onMount, type Component } from 'solid-js';
import { Button } from '../components/Button.tsx';
import { LAZY_COPY } from '../copy.ts';
import { COLORS, LAYOUT, TYPE } from './theme.ts';
import { shouldFocusHostOnMount, shouldRefocusHost, tryAgain, type LazyModule, type ScreenProps } from './lazyModule.ts';

/**
 * Renders a lazily loaded screen.
 * - Until the module is loaded, the screen is an empty full-size view that holds focus. That is the skeleton, drawn in
 *   the same frame as the route change: the App's opaque underlay paints non-video screens.
 * - When the module arrives, the screen mounts inside it and focus is passed down again (forwardFocus), so its own
 *   focus logic runs as if it had been there from the start.
 * - A failed load shows "Couldn't open this screen" with Try again, which reloads the app (see `tryAgain`); Back works
 *   as on any screen.
 */
export function LazyScreen<P extends ScreenProps>(props: { module: LazyModule<P>; props: P }) {
  let host: ElementNode | undefined;
  let alive = true;
  onCleanup(() => { alive = false; });
  const [comp, setComp] = createSignal<Component<P> | undefined>(props.module.loaded());
  const [failed, setFailed] = createSignal(false);
  // Runs after the screen's own mount code (its onMount and the microtasks it queued first).
  const refocus = () => { if (shouldRefocusHost(alive, activeElement(), host)) host?.setFocus(); };
  const load = () => {
    props.module.load().then((c) => {
      if (!alive) return;
      setComp(() => c);
      queueMicrotask(refocus);
    }, (err: unknown) => {
      console.warn('Screen failed to load', err instanceof Error ? err.name : 'Error');
      if (!alive) return;
      setFailed(true);
      queueMicrotask(refocus);
    });
  };
  if (!comp()) load();
  // Loading or failed: take focus from the screen this was opened from (its nodes are gone, its focus path is not).
  onMount(() => { if (shouldFocusHostOnMount(comp())) host?.setFocus(); });
  return (
    <View ref={host} width={LAYOUT.width} height={LAYOUT.height} forwardFocus={0}>
      <Show when={comp()} fallback={
        <Show when={failed()}>
          <View x={LAYOUT.safeX} y={LAYOUT.height / 2 - TYPE.title * 2} width={LAYOUT.width - 2 * LAYOUT.safeX} height={TYPE.title * 4} forwardFocus={1}>
            <Text width={LAYOUT.width - 2 * LAYOUT.safeX} maxWidth={LAYOUT.width - 2 * LAYOUT.safeX} contain="width" maxLines={1}
              fontSize={TYPE.title} color={COLORS.text}>{LAZY_COPY.failed}</Text>
            <Button y={TYPE.title + LAYOUT.gap * 2} label={LAZY_COPY.retry} onPress={() => tryAgain()} />
          </View>
        </Show>
      }>
        {(c) => createComponent(c(), props.props)}
      </Show>
    </View>
  );
}
