import { createSignal, onCleanup } from 'solid-js';
import { SettingsList, type SettingItem } from '../../components/SettingsList.tsx';
import { playback } from '../../playback/playback.ts';
import { settings } from '../../state/appState.ts';
import {
  FORMAT_OPTIONS, LIVE_DELAY_OPTIONS, SLEEP_DEFAULT_OPTIONS, cycleOption, formatLabel, liveDelayLabel, onOff, sleepDefaultLabel,
} from '../settingsLogic.ts';
import { SUBTITLE_LANGUAGE_OPTIONS, subtitleLanguageLabel } from '../../vod/subtitleLogic.ts';
import { saveSetting, type PageProps } from './shared.ts';

/** Playback: stream format (TS / HLS), live delay, the default sleep timer, the subtitle language and exact-match subtitles. */
export function PlaybackPage(props: PageProps) {
  const [sel, setSel] = createSignal(0);
  const format = () => settings()?.preferredFormat ?? 'ts';
  const liveDelay = () => settings()?.liveDelay ?? 'balanced';
  const sleep = (): number => settings()?.sleepTimerMinutes ?? 0;
  const subLang = () => settings()?.subtitleLanguage ?? 'off';
  const exact = () => settings()?.subtitleExactMatch ?? false;
  const items = (): SettingItem[] => [
    { id: 'format', label: 'Preferred stream format', value: formatLabel(format()), adjustable: true,
      help: "If channels don't start, try the other format." },
    { id: 'liveDelay', label: 'Live delay', value: liveDelayLabel(liveDelay()), adjustable: true,
      help: 'Low keeps you closer to live but may pause more often on Wi-Fi. Applies from the next channel.' },
    { id: 'sleep', label: 'Default sleep timer', value: sleepDefaultLabel(sleep()), adjustable: true,
      help: 'Starts with every channel you watch full screen' },
    { id: 'subtitleLanguage', label: 'Subtitle language', value: subtitleLanguageLabel(subLang()), adjustable: true,
      help: 'Movies and series start with subtitles in this language when they have them' },
    { id: 'subtitleExactMatch', label: 'Exact-match subtitles', value: onOff(exact()), adjustable: true,
      help: 'Online subtitles timed for your exact file. Reads a little of it: one extra connection.' },
  ];
  const change = (id: string, dir: 1 | -1) => {
    if (id === 'format') {
      void saveSetting({ preferredFormat: cycleOption(FORMAT_OPTIONS, format(), dir) });
      // The running stream used the old format: the next play (Home resumes it) picks the new one.
      playback.stop();
      return true;
    }
    if (id === 'liveDelay') {
      // Not applied to the running stream (the engine settings are fixed per open); the next channel uses it.
      void saveSetting({ liveDelay: cycleOption(LIVE_DELAY_OPTIONS, liveDelay(), dir) });
      return true;
    }
    if (id === 'sleep') {
      void saveSetting({ sleepTimerMinutes: cycleOption<number>(SLEEP_DEFAULT_OPTIONS, sleep(), dir) });
      return true;
    }
    if (id === 'subtitleExactMatch') {
      void saveSetting({ subtitleExactMatch: !exact() });
      return true;
    }
    if (id === 'subtitleLanguage') {
      void saveSetting({ subtitleLanguage: cycleOption(SUBTITLE_LANGUAGE_OPTIONS, subLang(), dir) });
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
