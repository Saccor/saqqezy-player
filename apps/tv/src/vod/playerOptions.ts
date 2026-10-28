import type { SeasonView, VersionView, VodPlayable } from '@iptv/app-api';
import type { TrackInfo } from '@iptv/player';
import type { OptionItem } from '../components/sheetLogic.ts';
import { COMMON_COPY, PLAYER_COPY, SOURCE_COPY, VOD_COPY } from '../copy.ts';
import { versionLabel } from './versionsLogic.ts';

/** The VOD player's options menu (the gear button): pages and their rows. No Solid, no Lightning: the screen wires it. */

export type OptionsPage = 'main' | 'audio' | 'source';

export interface OptionsState {
  /** The playing audio track's label ("Default" when none is known). */
  audio: string;
  /** The subtitles showing ("Off" when none). */
  subtitles: string;
  /** How many versions the title has (Source shows from 2). */
  versions: number;
  infoOn: boolean;
}

/** The main page: Audio track, Subtitles, Source (with versions), Stream info, then the app's Settings. */
export function optionsItems(s: OptionsState): OptionItem[] {
  return [
    { id: 'audio', label: PLAYER_COPY.audioTrack, value: s.audio },
    { id: 'subtitles', label: VOD_COPY.subtitles, value: s.subtitles },
    ...(s.versions > 1 ? [{ id: 'source', label: SOURCE_COPY.source, value: `${s.versions}` }] : []),
    { id: 'info', label: PLAYER_COPY.streamInfo, value: s.infoOn ? PLAYER_COPY.on : PLAYER_COPY.off },
    { id: 'settings', label: VOD_COPY.options.allSettings },
  ];
}

/**
 * The audio page: one row per track (`labels` from `trackLabels`), the active one marked, then Back. `browserLimit`:
 * the browser has no track list for files it plays itself (desktop Chrome lacks `video.audioTracks`), so none is
 * not this video's fault.
 */
export function audioItems(tracks: readonly TrackInfo[], labels: readonly string[], browserLimit = false): OptionItem[] {
  if (tracks.length === 0) return [{ id: 'back', label: browserLimit ? VOD_COPY.options.browserNoAudioList : VOD_COPY.options.noAudioList }];
  if (tracks.length === 1) return [{ id: 'back', label: PLAYER_COPY.oneAudio }];
  return [
    ...tracks.map((t, i) => ({ id: `track:${t.id}`, label: labels[i] ?? t.label, value: t.active ? PLAYER_COPY.selected : '' })),
    { id: 'back', label: COMMON_COPY.back },
  ];
}

/** The source page: every version of the title, the playing one marked, then Back. */
export function sourceItems(versions: readonly VersionView[], playingId: string | undefined): OptionItem[] {
  return [
    ...versions.map((v, i) => ({ id: `ver:${v.id}`, label: versionLabel(v, i + 1), value: v.id === playingId ? VOD_COPY.options.playing : '' })),
    { id: 'back', label: COMMON_COPY.back },
  ];
}

/** The id the title's versions are listed under: a movie's own id, an episode's series (version) id. */
export function versionOwnerId(p: VodPlayable): string | undefined {
  return p.kind === 'movie' ? p.itemId : p.series?.id;
}

/** The same episode in another version of the series (by season and episode number). */
export function matchingEpisode(seasons: readonly SeasonView[], season: number, episode: number): string | undefined {
  return seasons.find((s) => s.number === season)?.episodes.find((e) => e.episode === episode)?.id
    ?? seasons.flatMap((s) => s.episodes).find((e) => e.season === season && e.episode === episode)?.id;
}
