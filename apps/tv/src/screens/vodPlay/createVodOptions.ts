/**
 * The VOD player's Options sheet (the gear and the Menu key): audio track, subtitles, the title's other versions
 * ("Source"), stream info and a trip to Settings that resumes here. Not unit-tested: the pure rules live in
 * playerOptions.ts.
 */
import { createMemo, createSignal } from 'solid-js';
import type { ElementNode } from '@lightningtv/solid';
import type { VersionView, VodPlayable, VodTracks } from '@iptv/app-api';
import { api } from '../../api.ts';
import { PLAYER_COPY, VOD_COPY } from '../../copy.ts';
import { failureText } from '../../playback/failureText.ts';
import { playback } from '../../playback/playback.ts';
import { router, type ScreenEntry } from '../../shell/router.ts';
import { showToast } from '../../shell/Toast.tsx';
import { audioItems, matchingEpisode, optionsItems, sourceItems, versionOwnerId, type OptionsPage } from '../../vod/playerOptions.ts';
import { oneSpace, trackKey, trackLabels } from '../../vod/tracks.ts';
import { withLanguages } from '../../vod/versionsLogic.ts';
import type { VodCore } from './createVodCore.ts';
import type { LoadedSubtitleState } from './createLoadedSubtitle.ts';
import type { createVodTracks } from './createVodTracks.ts';
import { OPTIONS_ID, errName } from './layout.ts';

/** Desktop Chrome has no `video.audioTracks`: files it plays itself list no audio tracks (hls.js streams still do). */
const NO_TRACK_API = typeof document !== 'undefined' && !('audioTracks' in document.createElement('video'));
const CANT_PLAY_NOW = failureText({ reason: 'unavailable' });

export function createVodOptions(c: VodCore, sub: LoadedSubtitleState, tracks: ReturnType<typeof createVodTracks>, d: {
  /** The screen's entry (Settings goes back to it, resuming from here). */
  entry: () => ScreenEntry;
  chosen: VodTracks;
  infoOn: () => boolean;
  toggleInfo: () => boolean;
  focusBarOrRoot: () => void;
}) {
  const { p, cu, bump } = c;
  const { chosen, focusBarOrRoot } = d;

  /** The title's versions, listed under a movie's id or an episode's series id; loaded once it plays (or the menu opens). */
  const versionOwner = cu ? undefined : versionOwnerId(p);
  const [versions, setVersions] = createSignal<VersionView[]>([]);
  let versionsAsked = false;
  const loadVersions = () => {
    if (versionsAsked || !versionOwner) return;
    versionsAsked = true;
    const view = p.kind === 'movie' ? api.getMovie(versionOwner) : api.getSeries(versionOwner, versionOwner);
    view.then((v) => {
      if (!c.alive || !v || v.versions.length < 2) return;
      setVersions(v.versions);
      // Versions whose names give no language: the source's probe data usually does.
      if (v.versions.some((x) => !x.lang)) {
        api.getVersionLanguages(versionOwner).then((langs) => {
          if (c.alive && Object.keys(langs).length > 0) setVersions((cur) => withLanguages(cur, langs));
        }, (err) => console.warn('Version languages failed', errName(err)));
      }
    }, (err) => console.warn('Versions failed', errName(err)));
  };

  const [optionsPage, setOptionsPage] = createSignal<OptionsPage | undefined>(undefined);
  let optionsNode: ElementNode | undefined;
  let removeOptions: (() => void) | undefined;
  const focusOptions = () => queueMicrotask(() => { if (c.alive) optionsNode?.setFocus(); });
  const openOptions = () => {
    if (optionsPage() || tracks.pickerOpen()) return true;
    bump();
    loadVersions();
    setOptionsPage('main');
    removeOptions = router.pushOverlay(OPTIONS_ID, () => {
      removeOptions = undefined;
      setOptionsPage(undefined);
      focusBarOrRoot();
    });
    focusOptions();
    return true;
  };
  const closeOptions = () => {
    removeOptions?.();
    removeOptions = undefined;
    setOptionsPage(undefined);
  };

  const audioLabels = () => trackLabels(playback.audioTracks(), 'audio', tracks.langInput());
  const optionItems = createMemo(() => {
    tracks.rowsTick();
    const page = optionsPage();
    if (page === 'audio') return audioItems(playback.audioTracks(), audioLabels(), NO_TRACK_API);
    if (page === 'source') return sourceItems(versions(), versionOwner);
    const audios = playback.audioTracks();
    const a = audios.findIndex((t) => t.active);
    const texts = playback.textTracks();
    const s = texts.findIndex((t) => t.active);
    const ext = sub.external();
    const subtitles = sub.extOn() && ext ? oneSpace(ext.name)
      : s >= 0 ? trackLabels(texts, 'subtitle', tracks.langInput())[s] ?? PLAYER_COPY.on : PLAYER_COPY.off;
    const items = optionsItems({ audio: a >= 0 ? audioLabels()[a] ?? PLAYER_COPY.default : PLAYER_COPY.default, subtitles, versions: versions().length, infoOn: d.infoOn() });
    // Catch-up keeps nothing of its own: no Settings trip (the programme would start over).
    return cu ? items.filter((i) => i.id !== 'settings') : items;
  });

  /** Another version of this title, from where it is now; remembered for the title (as the detail's Versions list). */
  const switchSource = async (versionId: string) => {
    if (!versionOwner || versionId === versionOwner || c.switchBusy || !c.alive) return;
    c.switchBusy = true;
    const at = c.failed() ? (c.saveArmed ? (c.lastPos ?? c.startMs) : c.startMs) : c.playhead();
    c.save();
    let np: VodPlayable | undefined;
    let missing = false;
    try {
      await api.pickVodVersion(versionOwner, versionId).catch((err: unknown) => console.warn('Pick failed', errName(err)));
      if (p.kind === 'movie') {
        np = await api.getVodPlayable(versionId, undefined, true);
      } else {
        const sv = await api.getSeries(versionOwner, versionId);
        const ep = sv && p.series ? matchingEpisode(sv.seasons, p.series.season, p.series.episode) : undefined;
        if (ep) np = await api.getVodPlayable(ep, sv!.versionId);
        else missing = true;
      }
    } catch (err) {
      console.warn('Source switch failed', errName(err));
    }
    c.switchBusy = false;
    if (!c.alive) return;
    if (!np) {
      showToast(missing ? VOD_COPY.episodeNotInVersion : CANT_PLAY_NOW);
      return;
    }
    closeOptions();
    tracks.closePicker();
    router.replace('vodPlay', { playable: { ...np, resumeMs: Math.max(0, Math.round(at)) } });
  };

  /** All settings: saved first, and this screen's entry resumes from here when Settings goes back to it. */
  const openSettings = () => {
    const at = c.playhead();
    c.save();
    const entryParams = d.entry().params as { playable?: VodPlayable; fromStart?: boolean };
    entryParams.playable = { ...p, resumeMs: Math.max(0, Math.round(at)) };
    entryParams.fromStart = false;
    closeOptions();
    router.push('settings', { page: 'playback' });
  };

  const chooseOption = (id: string) => {
    bump();
    if (id === 'audio' || id === 'source') {
      setOptionsPage(id);
      focusOptions();
    } else if (id === 'back') {
      setOptionsPage('main');
      focusOptions();
    } else if (id === 'subtitles') {
      closeOptions();
      tracks.openPicker();
    } else if (id === 'info') {
      closeOptions();
      d.toggleInfo();
      focusBarOrRoot();
    } else if (id === 'settings') {
      openSettings();
    } else if (id.startsWith('track:')) {
      const t = playback.audioTracks().find((x) => x.id === id.slice('track:'.length));
      if (t) {
        playback.selectAudioTrack(t.id);
        chosen.audio = trackKey(t);
        tracks.remember({ audio: chosen.audio });
      }
      setOptionsPage('main');
      tracks.refreshRows();
      focusOptions();
    } else if (id.startsWith('ver:')) {
      void switchSource(id.slice('ver:'.length));
    }
  };

  return {
    optionsPage, optionItems, loadVersions, openOptions, closeOptions, chooseOption,
    optionsRef: (el: ElementNode) => { optionsNode = el; },
    /** Unmount: the sheet's back layer goes (without its close handler). */
    dispose: () => {
      removeOptions?.();
      router.removeOverlay(OPTIONS_ID);
    },
  };
}
