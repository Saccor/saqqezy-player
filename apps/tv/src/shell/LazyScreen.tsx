import { Show, Text, View, activeElement, type ElementNode } from '@lightningtv/solid';
import { createComponent, createSignal, onCleanup, type Component } from 'solid-js';
import { Button } from '../components/Button.tsx';
import { LAZY_COPY } from '../copy.ts';
import { COLORS, LAYOUT, TYPE } from './theme.ts';
import type { LazyModule, ScreenProps } from './lazyModule.ts';

/**
 * Renders a lazily loaded screen.
 * - Until the module is loaded, the screen is an empty full-size view that holds focus. That is the skeleton, drawn in
 *   the same frame as the route change: the App's opaque underlay paints non-video screens.
 * - When the module arrives, the screen mounts inside it and focus is passed down again (forwardFocus), so its own
 *   focus logic runs as if it had been there from the start.
 * - A failed load shows "Couldn't open this screen" with Try again; Back works as on any screen.
 */
export function LazyScreen<P extends ScreenProps>(props: { module: LazyModule<P>; props: P }) {
  let host: ElementNode | undefined;
  let alive = true;
  onCleanup(() => { alive = false; });
  const [comp, setComp] = createSignal<Component<P> | undefined>(props.module.loaded());
  const [failed, setFailed] = createSignal(false);
  const load = () => {
    setFailed(false);
    props.module.load().then((c) => {
      if (!alive) return;
      const hadFocus = host !== undefined && activeElement() === host;
      setComp(() => c);
      if (hadFocus) queueMicrotask(() => { if (alive) host?.setFocus(); });
    }, (err: unknown) => {
      console.warn('Screen failed to load', err instanceof Error ? err.name : 'Error');
      if (!alive) return;
      setFailed(true);
      queueMicrotask(() => { if (alive) host?.setFocus(); });
    });
  };
  if (!comp()) load();
  return (
    <View ref={host} width={LAYOUT.width} height={LAYOUT.height} forwardFocus={0}>
      <Show when={comp()} fallback={
        <Show when={failed()}>
          <View x={LAYOUT.safeX} y={LAYOUT.height / 2 - TYPE.title * 2} width={LAYOUT.width - 2 * LAYOUT.safeX} height={TYPE.title * 4} forwardFocus={1}>
            <Text width={LAYOUT.width - 2 * LAYOUT.safeX} maxWidth={LAYOUT.width - 2 * LAYOUT.safeX} contain="width" maxLines={1}
              fontSize={TYPE.title} color={COLORS.text}>{LAZY_COPY.failed}</Text>
            <Button y={TYPE.title + LAYOUT.gap * 2} label={LAZY_COPY.retry} onPress={load} />
          </View>
        </Show>
      }>
        {(c) => createComponent(c(), props.props)}
      </Show>
    </View>
  );
}
