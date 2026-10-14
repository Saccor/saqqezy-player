import { For, Show, Text, View } from '@lightningtv/solid';
import { createSignal, onCleanup, onMount } from 'solid-js';
import { api } from '../../api.ts';
import { SETTING_ROW_H, SettingsList, type SettingItem } from '../../components/SettingsList.tsx';
import { journal, playback, supervisor } from '../../playback/playback.ts';
import { debugOverlayVisible, setDebugOverlayVisible } from '../../shell/DebugOverlay.tsx';
import { COLORS, FONT, LAYOUT } from '../../shell/theme.ts';
import { platformId } from '../../state/appState.ts';
import { readDeviceInfo } from '../../platform/deviceInfo.ts';
import { diagnosticsLines, liveLines, onOff } from '../settingsLogic.ts';
import { journalSummary } from '../journalLogic.ts';
import { PlaybackLogView } from './PlaybackLogView.tsx';
import type { PageProps } from './shared.ts';

const LINE_H = 38;
const LABEL_W = 300;

/**
 * Diagnostics: app version, platform, sources with counts and times, the last errors and the settings, built
 * by `diagnosticsLines` (no credentials or URLs), a "Playback" summary line, the "Show debug overlay" toggle
 * and the "Playback log" row that opens `PlaybackLogView`.
 */
export function DiagnosticsPage(props: PageProps) {
  const [lines, setLines] = createSignal<[string, string][]>([]);
  const [sel, setSel] = createSignal(0);
  const [logOpen, setLogOpen] = createSignal(false);
  let alive = true;
  const items = (): SettingItem[] => [
    { id: 'debug', label: 'Show debug overlay', value: onOff(debugOverlayVisible()), adjustable: true,
      help: 'Frame rate, memory and player state' },
    { id: 'log', label: 'Playback log', help: 'What the player did, newest first' },
  ];
  const toggle = (id: string) => {
    if (id !== 'debug') return false;
    setDebugOverlayVisible(!debugOverlayVisible());
    return true;
  };
  const ok = (id: string) => {
    if (id === 'log') setLogOpen(true);
    else toggle(id);
  };
  onMount(() => {
    api.diagnostics().then((info) => {
      if (!alive) return;
      const all = diagnosticsLines(info, { platform: platformId, device: readDeviceInfo() });
      all.splice(2, 0, ['Player', playback.playerKind()]); // right after Platform
      const live = playback.current() ? liveLines(supervisor.liveInfo()) : [];
      all.splice(3, 0, ...live, ['Playback', journalSummary(journal.entries(), Date.now())]);
      setLines(all);
    }, (err: unknown) => {
      console.warn('Diagnostics failed', err instanceof Error ? err.name : 'Error');
      if (alive) setLines([['Diagnostics', 'Not available']]);
    });
  });
  onCleanup(() => { alive = false; props.register(undefined); });

  const linesY = SETTING_ROW_H * 2 + LAYOUT.gap;
  const maxLines = Math.floor((props.height - linesY) / LINE_H);
  return (
    <View x={props.x} y={props.y} width={props.width} height={props.height}>
      <Show when={!logOpen()} fallback={
        <PlaybackLogView width={props.width} height={props.height} register={props.register}
          onClose={() => setLogOpen(false)} />
      }>
        <SettingsList ref={props.register} x={0} y={0} width={props.width} height={SETTING_ROW_H * 2}
          items={items()} selected={sel()} onSelect={setSel} onAdjust={(id) => toggle(id)} onOk={ok}
          onLeftEdge={props.onLeftEdge} />
        <For each={lines().slice(0, maxLines)}>{(line, i) => (
          <View x={28} y={linesY + i() * LINE_H} width={props.width - 56} height={LINE_H}>
            <Text width={LABEL_W - 16} maxWidth={LABEL_W - 16} contain="width" maxLines={1} fontSize={FONT.small}
              color={COLORS.muted}>{line[0]}</Text>
            <Text x={LABEL_W} width={props.width - 56 - LABEL_W} maxWidth={props.width - 56 - LABEL_W} contain="width"
              maxLines={1} fontSize={FONT.small} color={COLORS.text}>{line[1]}</Text>
          </View>
        )}</For>
      </Show>
    </View>
  );
}
