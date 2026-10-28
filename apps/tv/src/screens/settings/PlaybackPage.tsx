import { createSignal, onCleanup } from 'solid-js';
import { SettingsList, type SettingItem } from '../../components/SettingsList.tsx';
import { deviceWindowMax, playback, pool } from '../../playback/playback.ts';
import { deviceCeiling } from '../multiview/windows.ts';
import { SETTINGS_COPY } from '../../copy.ts';
import { settings } from '../../state/appState.ts';
import {
  FORMAT_OPTIONS, LIVE_DELAY_OPTIONS, MAX_WINDOWS_OPTIONS, SLEEP_DEFAULT_OPTIONS, cycleOption, formatLabel, liveDelayLabel,
  maxWindowsLabel, onOff, sleepDefaultLabel,
} from '../settingsLogic.ts';
import { AUDIO_LANGUAGE_OPTIONS, SUBTITLE_LANGUAGE_OPTIONS, audioLanguageLabel, subtitleLanguageLabel } from '../../vod/subtitleLogic.ts';
import {
  PREFERRED_LANGUAGE_OPTIONS, preferredLanguageLabel, preferredLanguageOption, preferredLanguagesFor,
} from '../../vod/versionsLogic.ts';
import { saveSetting, type PageProps } from './shared.ts';

const P = SETTINGS_COPY.playback;

/**
 * Playback: stream format (TS / HLS), live delay, the default sleep timer, the subtitle and audio languages, exact-match subtitles,
 * for movies and series: combine duplicates and the preferred language, and multiview's Max windows where the device
 * can play more than one channel at once.
 */
export function PlaybackPage(props: PageProps) {
  const format = () => settings()?.preferredFormat ?? 'ts';
  const liveDelay = () => settings()?.liveDelay ?? 'balanced';
  const sleep = (): number => settings()?.sleepTimerMinutes ?? 0;
  const subLang = () => settings()?.subtitleLanguage ?? 'off';
  const audioLang = () => settings()?.audioLanguage ?? 'auto';
  const exact = () => settings()?.subtitleExactMatch ?? true;
  const combine = () => settings()?.combineDuplicates ?? true;
  const prefLang = () => preferredLanguageOption(settings()?.preferredLanguages);
  const maxWindows = () => settings()?.maxWindows ?? 'auto';
  const ceiling = (): number => deviceCeiling(deviceWindowMax());
  const multiviewItems = (): SettingItem[] => (ceiling() < 2 ? [] : [
    { id: 'maxWindows', label: P.maxWindows, value: maxWindowsLabel(maxWindows(), ceiling()), adjustable: true,
      help: P.maxWindowsHelp },
  ]);
  const items = (): SettingItem[] => [
    { id: 'format', label: P.format, value: formatLabel(format()), adjustable: true,
      help: P.formatHelp },
    { id: 'liveDelay', label: P.liveDelay, value: liveDelayLabel(liveDelay()), adjustable: true,
      help: P.liveDelayHelp },
    { id: 'sleep', label: P.sleep, value: sleepDefaultLabel(sleep()), adjustable: true,
      help: P.sleepHelp },
    { id: 'subtitleLanguage', label: P.subtitleLanguage, value: subtitleLanguageLabel(subLang()), adjustable: true,
      help: P.subtitleLanguageHelp },
    { id: 'audioLanguage', label: P.audioLanguage, value: audioLanguageLabel(audioLang()), adjustable: true,
      help: P.audioLanguageHelp },
    { id: 'subtitleExactMatch', label: P.exactMatch, value: onOff(exact()), adjustable: true,
      help: P.exactMatchHelp },
    { id: 'combineDuplicates', label: P.combine, value: onOff(combine()), adjustable: true,
      help: P.combineHelp },
    { id: 'preferredLanguage', label: P.preferredLanguage, value: preferredLanguageLabel(prefLang()), adjustable: true,
      help: P.preferredLanguageHelp },
    ...multiviewItems(),
  ];

  // A deep link ("Change" in first run) selects its row.
  const [sel, setSel] = createSignal(Math.max(0, items().findIndex((it) => it.id === props.focusItem)));
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
    if (id === 'combineDuplicates') {
      void saveSetting({ combineDuplicates: !combine() });
      return true;
    }
    if (id === 'preferredLanguage') {
      void saveSetting({ preferredLanguages: preferredLanguagesFor(cycleOption(PREFERRED_LANGUAGE_OPTIONS, prefLang(), dir)) });
      return true;
    }
    if (id === 'subtitleLanguage') {
      void saveSetting({ subtitleLanguage: cycleOption(SUBTITLE_LANGUAGE_OPTIONS, subLang(), dir) });
      return true;
    }
    if (id === 'maxWindows') {
      void saveSetting({ maxWindows: cycleOption(MAX_WINDOWS_OPTIONS, maxWindows(), dir) });
      return true;
    }
    if (id === 'audioLanguage') {
      void saveSetting({ audioLanguage: cycleOption(AUDIO_LANGUAGE_OPTIONS, audioLang(), dir) });
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
