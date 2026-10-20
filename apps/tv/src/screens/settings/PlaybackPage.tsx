import { createSignal, onCleanup } from 'solid-js';
import { SettingsList, type SettingItem } from '../../components/SettingsList.tsx';
import { playback } from '../../playback/playback.ts';
import { settings } from '../../state/appState.ts';
import {
  FORMAT_OPTIONS, LIVE_DELAY_OPTIONS, SLEEP_DEFAULT_OPTIONS, cycleOption, formatLabel, liveDelayLabel, onOff, sleepDefaultLabel,
} from '../settingsLogic.ts';
import { AUDIO_LANGUAGE_OPTIONS, SUBTITLE_LANGUAGE_OPTIONS, audioLanguageLabel, subtitleLanguageLabel } from '../../vod/subtitleLogic.ts';
import {
  PREFERRED_LANGUAGE_OPTIONS, preferredLanguageLabel, preferredLanguageOption, preferredLanguagesFor,
} from '../../vod/versionsLogic.ts';
import { saveSetting, type PageProps } from './shared.ts';

/**
 * Playback: stream format (TS / HLS), live delay, the default sleep timer, the subtitle and audio languages, exact-match subtitles,
 * and for movies and series: combine duplicates and the preferred language.
 */
export function PlaybackPage(props: PageProps) {
  const [sel, setSel] = createSignal(0);
  const format = () => settings()?.preferredFormat ?? 'ts';
  const liveDelay = () => settings()?.liveDelay ?? 'balanced';
  const sleep = (): number => settings()?.sleepTimerMinutes ?? 0;
  const subLang = () => settings()?.subtitleLanguage ?? 'off';
  const audioLang = () => settings()?.audioLanguage ?? 'auto';
  const exact = () => settings()?.subtitleExactMatch ?? true;
  const combine = () => settings()?.combineDuplicates ?? true;
  const prefLang = () => preferredLanguageOption(settings()?.preferredLanguages);
  const items = (): SettingItem[] => [
    { id: 'format', label: 'Preferred stream format', value: formatLabel(format()), adjustable: true,
      help: "If channels don't start, try the other format." },
    { id: 'liveDelay', label: 'Live delay', value: liveDelayLabel(liveDelay()), adjustable: true,
      help: 'Low keeps you closer to live but may pause more often on Wi-Fi. Applies from the next channel.' },
    { id: 'sleep', label: 'Default sleep timer', value: sleepDefaultLabel(sleep()), adjustable: true,
      help: 'Starts with every channel you watch full screen' },
    { id: 'subtitleLanguage', label: 'Subtitle language', value: subtitleLanguageLabel(subLang()), adjustable: true,
      help: 'Movies and series start with subtitles in this language when they have them' },
    { id: 'audioLanguage', label: 'Audio language', value: audioLanguageLabel(audioLang()), adjustable: true,
      help: 'Movies, series and channels start with sound in this language when they have it' },
    { id: 'subtitleExactMatch', label: 'Exact-match subtitles', value: onOff(exact()), adjustable: true,
      help: 'Online subtitles timed for your exact file. Reads a little of it (never on one-connection accounts).' },
    { id: 'combineDuplicates', label: 'Combine duplicates', value: onOff(combine()), adjustable: true,
      help: 'Movies and series: one card per title. Languages and qualities are under Versions.' },
    { id: 'preferredLanguage', label: 'Preferred language', value: preferredLanguageLabel(prefLang()), adjustable: true,
      help: 'Which version of a title Play starts' },
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
