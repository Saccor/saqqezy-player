/**
 * The full-screen player's Options sheet (Menu, long OK, right click): audio track (remembered per channel), aspect,
 * sleep timer, stream info, multiview, favourite, "From the start" and a combined channel's source. Also applies the
 * remembered audio track whenever a channel plays. Not unit-tested: the pure rules live in playerLogic.ts and tracks.ts.
 */
import { createEffect, createMemo, createSignal, on } from 'solid-js';
import type { ElementNode } from '@lightningtv/solid';
import type { PlayableChannel } from '@iptv/app-api';
import type { AspectMode } from '@iptv/player';
import { api } from '../../api.ts';
import { CATCHUP_COPY, COMMON_COPY, FAV_COPY, MULTIVIEW_COPY, PLAYER_COPY, SOURCE_COPY, favChangedToast, favToggleLabel } from '../../copy.ts';
import { fromOptionItem, type OptionItem } from '../../components/sheetLogic.ts';
import { deviceWindowMax, playback, player, sleepTimer } from '../../playback/playback.ts';
import { nextSleepOption, type SleepState } from '../../playback/sleepTimer.ts';
import { sourceOptions } from '../../playback/sourceLogic.ts';
import { streamInfoLines } from '../../playback/streamInfo.ts';
import { router } from '../../shell/router.ts';
import { showToast } from '../../shell/Toast.tsx';
import type { createLayerSet } from '../../shell/layerSet.ts';
import { settings } from '../../state/appState.ts';
import { channelLanguageInput, pickAudioTrack, trackKey, trackLabels } from '../../playback/tracks.ts';
import { deviceCeiling, windowLimit } from '../multiview/windows.ts';
import { aspectLabel, multiviewOffered, nextAspect, sleepLabel } from '../playerLogic.ts';

export const OPTIONS_ID = 'playerOptions';
export const INFO_ID = 'streamInfo';

/** Session-only choice (not persisted): aspect for every channel. */
let sessionAspect: AspectMode = 'auto';
/** The aspect chosen this session (every Player starts with it). */
export const sessionAspectNow = (): AspectMode => sessionAspect;
/**
 * The audio track chosen per channel (a `trackKey`), read from the worker once per channel and kept here for the
 * session: `has` means the worker was asked, an undefined value means it remembers nothing.
 */
const audioChoice = new Map<string, string | undefined>();

/** The channel's (or its group's) language prefix, for audio tracks that name no language. */
export const liveLangs = () => {
  const c = playback.current();
  return channelLanguageInput(c?.name, c?.group);
};

export function createPlayerOptions(d: {
  alive: () => boolean;
  layers: ReturnType<typeof createLayerSet>;
  now: () => number;
  shown: () => PlayableChannel | undefined;
  setShown: (ch: PlayableChannel) => void;
  sleep: () => SleepState;
  sleepMinutes: () => number;
  setSleepMinutes: (m: number) => void;
  /** Sleep choices run in seconds-scale in a DEV test (`?sleepTest=1`). */
  sleepScale: number;
  focusRoot: () => void;
  /** The sheet opens: number entry and the banner go. */
  beforeOpen: () => void;
  /** Plays another stream of the channel (Choose source). */
  jumpTo: (load: () => Promise<PlayableChannel | undefined>) => Promise<void>;
}) {
  const { alive, layers, shown, focusRoot } = d;
  const [menuPage, setMenuPage] = createSignal<'main' | 'audio' | 'source' | undefined>(undefined);
  const [infoOn, setInfoOn] = createSignal(false);
  const [infoTick, setInfoTick] = createSignal(0);
  const [aspect, setAspect] = createSignal<AspectMode>(sessionAspect);
  let menuNode: ElementNode | undefined;

  // ---- audio track memory ----

  /**
   * Once a channel plays: the remembered track for it, else the preferred language from Settings (`pickAudioTrack`;
   * a language pick is applied but not remembered as the user's choice). The memory is read from the worker the first
   * time a channel plays this session.
   */
  const applyAudio = async (id: string) => {
    if (!audioChoice.has(id)) {
      const key = await api.getLiveAudio(id).catch(() => undefined);
      if (!audioChoice.has(id)) audioChoice.set(id, key);
    }
    if (!alive() || playback.current()?.id !== id || playback.status()?.kind !== 'playing') return;
    const t = pickAudioTrack(player.audioTracks(), audioChoice.get(id), settings()?.audioLanguage ?? 'auto');
    if (t && !t.active) player.selectAudioTrack(t.id);
  };

  createEffect(on(() => [playback.status()?.kind, playback.current()?.id] as const, ([kind, id]) => {
    if (kind !== 'playing' || !id) return;
    void applyAudio(id);
  }));

  // ---- the sheet ----

  const focusMenu = () => queueMicrotask(() => menuNode?.setFocus());
  const onMenuClosed = () => { setMenuPage(undefined); focusRoot(); };
  const closeMenu = () => {
    layers.remove(OPTIONS_ID);
    setMenuPage(undefined);
    focusRoot();
  };
  const openMenu = () => {
    if (menuPage()) return true;
    d.beforeOpen();
    setMenuPage('main');
    layers.open(OPTIONS_ID, onMenuClosed);
    focusMenu();
    return true;
  };
  const setInfo = (visible: boolean) => {
    setInfoOn(visible);
    if (visible) {
      layers.open(INFO_ID, () => setInfoOn(false));
      // Keep the menu as the top layer, so Back closes it before the panel.
      if (menuPage()) layers.open(OPTIONS_ID, onMenuClosed);
    } else {
      layers.remove(INFO_ID);
    }
  };

  const menuItems = createMemo<OptionItem[]>(() => {
    d.now();
    const page = menuPage();
    if (page === 'audio') {
      const tracks = player.audioTracks();
      if (tracks.length === 0) return [{ id: 'back', label: PLAYER_COPY.noAudioList }];
      if (tracks.length === 1) return [{ id: 'back', label: PLAYER_COPY.oneAudio }];
      const labels = trackLabels(tracks, 'audio', liveLangs());
      return [
        ...tracks.map((t, i) => ({ id: `track:${t.id}`, label: labels[i] ?? t.label, value: t.active ? PLAYER_COPY.selected : '' })),
        { id: 'back', label: COMMON_COPY.back },
      ];
    }
    const cur = playback.current();
    const sources = cur?.sources ?? [];
    if (page === 'source') {
      return [
        ...sourceOptions(sources, cur?.id).map((o) => ({ id: `src:${o.id}`, label: o.label })),
        { id: 'back', label: COMMON_COPY.back },
      ];
    }
    const tracks = player.audioTracks();
    const activeAt = tracks.findIndex((t) => t.active);
    return [
      { id: 'audio', label: PLAYER_COPY.audioTrack, value: activeAt >= 0 ? trackLabels(tracks, 'audio', liveLangs())[activeAt] ?? PLAYER_COPY.default : PLAYER_COPY.default },
      { id: 'aspect', label: PLAYER_COPY.aspectRatio, value: aspectLabel(aspect()) },
      { id: 'sleep', label: PLAYER_COPY.sleepTimer, value: sleepLabel(d.sleepMinutes(), d.sleep().kind === 'armed' ? sleepTimer.minutesLeft() : undefined) },
      { id: 'info', label: PLAYER_COPY.streamInfo, value: infoOn() ? PLAYER_COPY.on : PLAYER_COPY.off },
      // Several channels at once, where this device can play them (spec 2026-10-20-multiview §2.1).
      ...(multiviewOffered(windowLimit(deviceCeiling(deviceWindowMax()), settings()?.maxWindows ?? 'auto'))
        ? [{ id: 'multiview', label: MULTIVIEW_COPY.entry }] : []),
      { id: 'favourite', label: favToggleLabel(shown()?.favourite === true) },
      // Catch-up channel with a programme on now: play it from its start (spec 2026-10-20-catch-up §5.2).
      ...(shown()?.archiveDays !== undefined && shown()?.now ? [{ id: 'fromStart', label: CATCHUP_COPY.fromStart }] : []),
      // A combined channel: pick which of its streams plays.
      ...(sources.length > 1 ? [{ id: 'source', label: SOURCE_COPY.source, value: `${sources.length}` }] : []),
    ];
  });
  const menuRows = createMemo(() => menuItems().map(fromOptionItem));

  const choose = (id: string) => {
    if (id === 'multiview') {
      closeMenu();
      router.push('multiview', {});
      return;
    }
    if (id === 'audio' || id === 'source') {
      setMenuPage(id);
      focusMenu();
    } else if (id.startsWith('src:')) {
      // Choose source: that stream plays now and first from now on (a new tune).
      const sourceId = id.slice('src:'.length);
      const row = playback.currentRowId();
      closeMenu();
      if (row) api.pickLiveSource(row, sourceId).catch(() => undefined);
      void d.jumpTo(() => api.getPlayable(sourceId, { exact: true }));
    } else if (id === 'back') {
      setMenuPage('main');
      focusMenu();
    } else if (id.startsWith('track:')) {
      const trackId = id.slice('track:'.length);
      const t = player.audioTracks().find((x) => x.id === trackId);
      player.selectAudioTrack(trackId);
      const cur = playback.current();
      if (cur && t) {
        const key = trackKey(t);
        audioChoice.set(cur.id, key);
        api.setLiveAudio(cur.id, key).catch((err) => console.warn('Audio choice save failed', err));
      }
      setMenuPage('main');
      focusMenu();
    } else if (id === 'aspect') {
      const next = nextAspect(aspect());
      sessionAspect = next;
      setAspect(next);
      player.setAspect(next);
    } else if (id === 'sleep') {
      const next = nextSleepOption(d.sleepMinutes());
      d.setSleepMinutes(next);
      sleepTimer.set(next * d.sleepScale);
    } else if (id === 'info') {
      setInfo(!infoOn());
    } else if (id === 'fromStart') {
      const ch = shown();
      closeMenu();
      if (!ch?.now) return;
      api.getCatchupPlayable(ch.id, ch.now.start).then((r) => {
        if (!alive()) return;
        if ('kind' in r) router.push('vodPlay', { catchup: r });
        else showToast(CATCHUP_COPY.notAvailable);
      }, (err) => console.warn('From the start failed', err instanceof Error ? err.name : 'Error'));
    } else if (id === 'favourite') {
      const ch = shown();
      closeMenu();
      if (!ch) return;
      api.toggleFavourite(ch.id).then((on) => {
        if (!alive()) return;
        if (shown()?.id === ch.id) d.setShown({ ...ch, favourite: on });
        showToast(favChangedToast(on));
      }).catch(() => showToast(FAV_COPY.failed));
    }
  };

  const infoLines = () => {
    infoTick();
    return streamInfoLines(player.streamInfo(), player.currentUrl(), playback.status());
  };

  return {
    menuPage, menuRows, infoOn, infoLines, openMenu, choose,
    /** The once-a-second stream info refresh (while the panel shows). */
    tickInfo: () => { if (infoOn()) setInfoTick((v) => v + 1); },
    menuRef: (el: ElementNode) => { menuNode = el; },
    /** The sheet when it is open (the sleep dialog's "Keep watching" returns there), else nothing. */
    focusMenuIfOpen: (): boolean => {
      if (!menuPage()) return false;
      queueMicrotask(() => { if (alive()) menuNode?.setFocus(); });
      return true;
    },
  };
}
