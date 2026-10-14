import { For, Text, View } from '@lightningtv/solid';
import { createSignal, onCleanup, onMount } from 'solid-js';
import { api } from '../../api.ts';
import { SETTING_ROW_H, SettingsList, type SettingItem } from '../../components/SettingsList.tsx';
import { debugOverlayVisible, setDebugOverlayVisible } from '../../shell/DebugOverlay.tsx';
import { COLORS, FONT, LAYOUT } from '../../shell/theme.ts';
import { platformId } from '../../state/appState.ts';
import { diagnosticsLines, onOff } from '../settingsLogic.ts';
import type { PageProps } from './shared.ts';

const LINE_H = 38;
const LABEL_W = 300;

/**
 * Diagnostics: app version, platform, sources with counts and times, the last errors and the settings, built
 * by `diagnosticsLines` (no credentials or URLs), plus the "Show debug overlay" toggle.
 */
export function DiagnosticsPage(props: PageProps) {
  const [lines, setLines] = createSignal<[string, string][]>([]);
  const [sel, setSel] = createSignal(0);
  let alive = true;
  const items = (): SettingItem[] => [
    { id: 'debug', label: 'Show debug overlay', value: onOff(debugOverlayVisible()), adjustable: true,
      help: 'Frame rate, memory and player state' },
  ];
  const toggle = (id: string) => {
    if (id !== 'debug') return false;
    setDebugOverlayVisible(!debugOverlayVisible());
    return true;
  };
  onMount(() => {
    api.diagnostics().then((info) => {
      if (alive) setLines(diagnosticsLines(info, { platform: platformId }));
    }, (err: unknown) => {
      console.warn('Diagnostics failed', err instanceof Error ? err.name : 'Error');
      if (alive) setLines([['Diagnostics', 'Not available']]);
    });
  });
  onCleanup(() => { alive = false; props.register(undefined); });

  const linesY = SETTING_ROW_H + LAYOUT.gap;
  const maxLines = Math.floor((props.height - linesY) / LINE_H);
  return (
    <View x={props.x} y={props.y} width={props.width} height={props.height}>
      <SettingsList ref={props.register} x={0} y={0} width={props.width} height={SETTING_ROW_H}
        items={items()} selected={sel()} onSelect={setSel} onAdjust={(id) => toggle(id)} onOk={toggle}
        onLeftEdge={props.onLeftEdge} />
      <For each={lines().slice(0, maxLines)}>{(line, i) => (
        <View x={28} y={linesY + i() * LINE_H} width={props.width - 56} height={LINE_H}>
          <Text width={LABEL_W - 16} maxWidth={LABEL_W - 16} contain="width" maxLines={1} fontSize={FONT.small}
            color={COLORS.muted}>{line[0]}</Text>
          <Text x={LABEL_W} width={props.width - 56 - LABEL_W} maxWidth={props.width - 56 - LABEL_W} contain="width"
            maxLines={1} fontSize={FONT.small} color={COLORS.text}>{line[1]}</Text>
        </View>
      )}</For>
    </View>
  );
}
