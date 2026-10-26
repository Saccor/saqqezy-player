import { Show, View } from '@lightningtv/solid';
import { createSignal, onCleanup, onMount } from 'solid-js';
import { api } from '../../api.ts';
import { KeyValuePanel } from '../../components/KeyValuePanel.tsx';
import { KV_LINE_H } from '../../components/infoBlockLogic.ts';
import { SETTING_ROW_H, SettingsList, type SettingItem } from '../../components/SettingsList.tsx';
import { deviceRefusal, deviceWindowMax, journal, playback, supervisor, testMultiviewAgain } from '../../playback/playback.ts';
import { deviceWindowsLine } from '../../playback/deviceWindows.ts';
import { debugOverlayVisible, setDebugOverlayVisible } from '../../shell/DebugOverlay.tsx';
import { LAYOUT, SPACE } from '../../shell/theme.ts';
import { platformId } from '../../state/appState.ts';
import { readDeviceInfo } from '../../platform/deviceInfo.ts';
import { diagnosticsLines, liveLines, onOff } from '../settingsLogic.ts';
import { journalSummary } from '../journalLogic.ts';
import { ConnectionsView } from './ConnectionsView.tsx';
import { PlaybackLogView } from './PlaybackLogView.tsx';
import type { PageProps } from './shared.ts';

/**
 * Diagnostics: app version, platform, sources with counts and times, the last errors and the settings, built
 * by `diagnosticsLines` (no credentials or URLs), a "Playback" summary line, the "Show debug overlay" toggle,
 * the "Playback log" row that opens `PlaybackLogView` and the "Connections" row (multiview) that opens
 * `ConnectionsView`, plus "Test multiview again" once the TV refused a second picture.
 */
/** Labels like "Exact-match subtitles" need the wide column the page always had. */
const DIAGNOSTICS_LABEL_W = 300;

export function DiagnosticsPage(props: PageProps) {
  const [lines, setLines] = createSignal<[string, string][]>([]);
  const [sel, setSel] = createSignal(0);
  const [view, setView] = createSignal<'list' | 'log' | 'connections'>('list');
  let alive = true;
  const items = (): SettingItem[] => [
    { id: 'debug', label: 'Show debug overlay', value: onOff(debugOverlayVisible()), adjustable: true,
      help: 'Frame rate, memory and player state' },
    { id: 'log', label: 'Playback log', help: 'What the player did, newest first' },
    { id: 'connections', label: 'Connections', help: 'Multiview: what your source reports, and each window opened or refused' },
    ...(deviceRefusal() ? [{ id: 'mvAgain', label: 'Test multiview again', help: deviceWindowsLine(deviceWindowMax(), deviceRefusal()) }] : []),
  ];
  const rows = () => items().length;
  const toggle = (id: string) => {
    if (id !== 'debug') return false;
    setDebugOverlayVisible(!debugOverlayVisible());
    return true;
  };
  const ok = (id: string) => {
    if (id === 'log') setView('log');
    else if (id === 'connections') setView('connections');
    else if (id === 'mvAgain') {
      testMultiviewAgain();
      setSel(0);
      setLines((all) => all.map((l) => (l[0] === 'Multiview' ? ['Multiview', deviceWindowsLine(deviceWindowMax(), undefined)] : l)));
    } else toggle(id);
  };
  onMount(() => {
    api.diagnostics().then((info) => {
      if (!alive) return;
      const all = diagnosticsLines(info, { platform: platformId, device: readDeviceInfo() });
      all.splice(2, 0, ['Player', playback.playerKind()], ['Multiview', deviceWindowsLine(deviceWindowMax(), deviceRefusal())]);
      const live = playback.current() ? liveLines(supervisor.liveInfo()) : [];
      all.splice(4, 0, ...live, ['Playback', journalSummary(journal.entries(), Date.now())]);
      setLines(all);
    }, (err: unknown) => {
      console.warn('Diagnostics failed', err instanceof Error ? err.name : 'Error');
      if (alive) setLines([['Diagnostics', 'Not available']]);
    });
  });
  onCleanup(() => { alive = false; props.register(undefined); });

  const linesY = () => SETTING_ROW_H * rows() + LAYOUT.gap;
  const maxLines = () => Math.floor((props.height - linesY()) / KV_LINE_H);
  return (
    <View x={props.x} y={props.y} width={props.width} height={props.height}>
      <Show when={view() === 'list'} fallback={view() === 'log'
        ? <PlaybackLogView width={props.width} height={props.height} register={props.register} onClose={() => setView('list')} />
        : <ConnectionsView width={props.width} height={props.height} register={props.register} onClose={() => setView('list')} />
      }>
        <SettingsList ref={props.register} x={0} y={0} width={props.width} height={SETTING_ROW_H * rows()}
          items={items()} selected={sel()} onSelect={setSel} onAdjust={(id) => toggle(id)} onOk={ok}
          onLeftEdge={props.onLeftEdge} />
        <KeyValuePanel x={SPACE.l} y={linesY()} width={props.width - SPACE.xl} lines={lines()} maxLines={maxLines()} labelW={DIAGNOSTICS_LABEL_W} />
      </Show>
    </View>
  );
}
