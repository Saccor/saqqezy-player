import { createSignal, onCleanup } from 'solid-js';
import { SettingsList, type SettingItem } from '../../components/SettingsList.tsx';
import { playback } from '../../playback/playback.ts';
import { settings } from '../../state/appState.ts';
import { FORMAT_OPTIONS, SLEEP_DEFAULT_OPTIONS, cycleOption, formatLabel, sleepDefaultLabel } from '../settingsLogic.ts';
import { saveSetting, type PageProps } from './shared.ts';

/** Playback: preferred stream format (TS / HLS) and the default sleep timer. */
export function PlaybackPage(props: PageProps) {
  const [sel, setSel] = createSignal(0);
  const format = () => settings()?.preferredFormat ?? 'ts';
  const sleep = (): number => settings()?.sleepTimerMinutes ?? 0;
  const items = (): SettingItem[] => [
    { id: 'format', label: 'Preferred stream format', value: formatLabel(format()), adjustable: true,
      help: "If channels don't start, try the other format." },
    { id: 'sleep', label: 'Default sleep timer', value: sleepDefaultLabel(sleep()), adjustable: true,
      help: 'Starts with every channel you watch full screen' },
  ];
  const change = (id: string, dir: 1 | -1) => {
    if (id === 'format') {
      void saveSetting({ preferredFormat: cycleOption(FORMAT_OPTIONS, format(), dir) });
      // The running stream used the old format: the next play (Home resumes it) picks the new one.
      playback.stop();
      return true;
    }
    if (id === 'sleep') {
      void saveSetting({ sleepTimerMinutes: cycleOption<number>(SLEEP_DEFAULT_OPTIONS, sleep(), dir) });
      return true;
    }
    return false;
  };
  onCleanup(() => props.register(undefined));
  return (
    <SettingsList ref={props.register} x={props.x} y={props.y} width={props.width} height={props.height}
      items={items()} selected={sel()} onSelect={setSel} onAdjust={change} onOk={(id) => change(id, 1)}
      onLeftEdge={props.onLeftEdge} />
  );
}
