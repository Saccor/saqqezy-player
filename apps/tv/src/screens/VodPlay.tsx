import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal, onCleanup, onMount } from 'solid-js';
import type { PlayableChannel, VodPlayable } from '@iptv/app-api';
import { playback } from '../playback/playback.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';

const TITLE_MS = 4000;

/**
 * Basic fullscreen play for a movie (Plan 3). No seek, pause, resume or progress yet: Plan 4 replaces this with the
 * VOD player. The stream goes through the shared playback stack; Back stops it, and so does leaving the screen.
 */
export function VodPlayScreen(props: { entry: ScreenEntry }) {
  const p = (props.entry.params as { playable: VodPlayable }).playable;
  const [showTitle, setShowTitle] = createSignal(true);
  let root: ElementNode | undefined;
  let titleTimer: ReturnType<typeof setTimeout> | undefined;

  const armTitle = () => {
    setShowTitle(true);
    if (titleTimer !== undefined) clearTimeout(titleTimer);
    titleTimer = setTimeout(() => setShowTitle(false), TITLE_MS);
  };

  onMount(() => {
    playback.setRect('fullscreen');
    // The playback controller speaks channels: a VOD title is a channel-shaped stand-in (never shown in channel UI).
    // The name stays empty: it would land in the persisted playback journal; the title is shown from `p`.
    const ch: PlayableChannel = { id: `vod:${p.itemId}`, number: 0, name: '', group: '', favourite: false, url: p.url };
    playback.playChannel(ch);
    armTitle();
    root?.setFocus();
  });
  onCleanup(() => {
    if (titleTimer !== undefined) clearTimeout(titleTimer);
    playback.stop();
  });

  const failed = () => playback.status()?.kind === 'failed';

  return (
    <View ref={(el) => { root = el; }} width={LAYOUT.width} height={LAYOUT.height}
      onBack={() => { playback.stop(); router.back(); return true; }}
      onEnter={() => { armTitle(); return true; }}>
      <Show when={showTitle() || failed()}>
        <View width={LAYOUT.width} height={200} color={0x0b0d12cc}>
          <Text x={LAYOUT.safeX} y={LAYOUT.safeY} width={LAYOUT.width - LAYOUT.safeX * 2} maxWidth={LAYOUT.width - LAYOUT.safeX * 2}
            contain="width" maxLines={1} fontSize={FONT.title} color={COLORS.text}>{p.title}</Text>
          <Text x={LAYOUT.safeX} y={LAYOUT.safeY + 70} fontSize={FONT.small} color={failed() ? COLORS.error : COLORS.muted}>
            {failed() ? "This video can't play on this device." : 'Back to return'}
          </Text>
        </View>
      </Show>
    </View>
  );
}
