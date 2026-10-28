import { Show, View } from '@lightningtv/solid';
import { createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import type { VodTracks } from '@iptv/app-api';
import { cueAt } from '@iptv/core';
import { api } from '../api.ts';
import { MESSAGE_BOXES } from '../components/messageFit.ts';
import { useNotice } from '../components/Notice.tsx';
import { mediaBadges } from '../playback/mediaBadges.ts';
import { onLogicalKey } from '../input/keys.ts';
import { usePointerTarget } from '../input/pointer.ts';
import { failureText } from '../playback/failureText.ts';
import { playback, player } from '../playback/playback.ts';
import { CATCHUP_COPY, PLAYER_COPY, VOD_COPY } from '../copy.ts';
import { notAvailableFailure } from '../vod/catchupLogic.ts';
import { streamInfoLines } from '../playback/streamInfo.ts';
import { KeyValuePanel } from '../components/KeyValuePanel.tsx';
import { staticCaps } from '@iptv/player';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, LAYOUT } from '../shell/theme.ts';
import { activeMaxConnections } from '../state/activeLimit.ts';
import { platformId } from '../state/appState.ts';
import { showToast } from '../shell/Toast.tsx';
import { VolumeOsd } from '../components/VolumeOsd.tsx';
import { volumeStep } from '../video/volume.ts';
import { bufferedEndMs } from '../vod/timelineLogic.ts';
import {
  DV_COLOURS_TEXT, PROGRESS_SAVE_MS, dvColoursWarning, cueText, knownDuration, nextCardText, noSoundText,
  coverVideo, coverLatch, pauseOnHidden,
} from '../vod/vodPlayerLogic.ts';
import { oneSpace } from '../vod/tracks.ts';
import { SUBTITLE_KEY_EXT, onlineLanguageLabel, subtitleTime } from '../vod/subtitleLogic.ts';
import { createVodCore } from './vodPlay/createVodCore.ts';
import { createVodSeek } from './vodPlay/createVodSeek.ts';
import { createVodCatchup } from './vodPlay/createVodCatchup.ts';
import { createLoadedSubtitle } from './vodPlay/createLoadedSubtitle.ts';
import { createSubtitleFinder } from './vodPlay/createSubtitleFinder.ts';
import { createVodTracks } from './vodPlay/createVodTracks.ts';
import { createVodOptions } from './vodPlay/createVodOptions.ts';
import { createEpisodeSwitch } from './vodPlay/createEpisodeSwitch.ts';
import { createVodFocus } from './vodPlay/createVodFocus.ts';
import { createVodKeys } from './vodPlay/createVodKeys.ts';
import { SubtitleCue, VodControls } from './vodPlay/VodOverlay.tsx';
import { VodCard } from './vodPlay/VodCard.tsx';
import { VodSheets } from './vodPlay/VodSheets.tsx';
import { INFO_ID, TICK_MS, errName } from './vodPlay/layout.ts';
import { cardActions, vodStatusText } from './vodPlay/vodPlayLogic.ts';

/** Whether this display shows Dolby Vision profile 5 ('none' on Samsung; unknown elsewhere until probed). */
const DV5 = staticCaps(platformId, 'native').display.hdr.dv5?.value;
/** How often a loaded subtitle file's cue is looked up (the engines' own subtitles poll at the same rate). */
const EXT_SUB_POLL_MS = 250;

/**
 * The VOD player: fullscreen video with a bottom overlay (title, progress, times, actions), pause, a seek marker that
 * commits 500 ms after the last press, resume, progress saves, audio and subtitle choices remembered per title (per series for episodes), drawn
 * subtitles for engines that cannot draw them, the next-episode card, and the failure messages. Its parts live in
 * `vodPlay/`: the shared state (`createVodCore`), seeking, catch-up, the subtitle file and where it comes from, the
 * track choices, Options and the episode switch; this component wires them to the keys, the tick and the drawing.
 */
export function VodPlayScreen(props: { entry: ScreenEntry }) {
  const c = createVodCore(props.entry);
  const { p, cu, startMs, bump, visible, failed, ended, status } = c;

  const focus = createVodFocus(c);
  const { focusRoot, focusCard, focusBarOrRoot } = focus;
  let endedHandled = false;
  /** The no-sound toast was shown (once per title). */
  let soundWarned = false;
  let dvWarned = false;
  /** True from the first picture of this open; until then an opaque view covers the video plane (`coverVideo`). */
  const [latch, setLatch] = createSignal({ armed: false, played: false });
  const played = () => latch().played;
  // Stream info (Info key): codec, resolution and dynamic range. Never the URL path (`streamInfoLines`).
  const [infoOn, setInfoOn] = createSignal(false);
  const [infoTick, setInfoTick] = createSignal(0);
  const toggleInfo = () => {
    if (infoOn()) {
      setInfoOn(false);
      router.removeOverlay(INFO_ID);
    } else {
      setInfoOn(true);
      router.pushOverlay(INFO_ID, () => setInfoOn(false));
    }
    return true;
  };
  const infoLines = () => {
    infoTick();
    return streamInfoLines(player.streamInfo(), player.currentUrl(), playback.status(), p.video);
  };
  /** The choices to (re)apply whenever the stream starts playing; updated by the picker. */
  const chosen: VodTracks = { ...p.tracks };

  // The parts (each reads and writes the shared state `c`; the later ones are reached lazily from the earlier ones).
  const catchup = createVodCatchup(c, { closePicker: () => tracks.closePicker(), dropSeek: () => seek.dropSeek(), focusCard });
  const seek = createVodSeek(c, { notAvail: catchup.notAvail, reopenAt: catchup.reopenAt });
  const sub = createLoadedSubtitle(c, {
    chosen, remember: (t) => tracks.remember(t), applySubtitle: () => tracks.applySubtitle(), refreshRows: () => tracks.refreshRows(),
  });
  const finder = createSubtitleFinder(c, sub, { focusBarOrRoot });
  const tracks = createVodTracks(c, sub, finder, { chosen, focusBarOrRoot });
  const options = createVodOptions(c, sub, tracks, { entry: () => props.entry, chosen, infoOn, toggleInfo, focusBarOrRoot });
  const episodes = createEpisodeSwitch(c, { closePicker: tracks.closePicker, leave: (saveFirst) => leave(saveFirst), focusCard });
  const { endCard, notAvail } = catchup;
  const { dropSeek } = seek;

  // What is playing, as badges under the title while the controls show: re-read each tick (the engine learns the
  // size, frame rate and tracks after the start), redrawn only when a badge changes.
  const badges = createMemo((): string[] => {
    if (!visible()) return [];
    c.now();
    const ext = sub.external();
    const extLang = sub.extLanguage();
    return mediaBadges({
      info: player.streamInfo(), hint: p.video, audio: playback.audioTracks(), text: playback.textTracks(), languages: tracks.langInput(),
      ...(ext && chosen.subtitle === SUBTITLE_KEY_EXT ? { external: extLang ? onlineLanguageLabel(extLang) : '', externalCc: ext.cc === true } : {}),
    });
  }, [], { equals: (a, b) => a.join('|') === b.join('|') });

  /** Back: save, stop, leave. After a catch-up programme, the live channel that played before plays again. */
  const leave = (saveFirst = true) => {
    if (!c.alive) return;
    tracks.closePicker();
    options.closeOptions();
    finder.closeLinkEntry();
    finder.closeOnline();
    finder.closeVersions();
    if (saveFirst) c.save();
    c.stopOurs();
    c.alive = false;
    router.back();
    if (c.liveBefore) catchup.resumeLive(c.liveBefore);
  };

  const keys = createVodKeys(c, { focus, seek, catchup, tracks, options, episodes, leave });
  const { onBack, onEnter } = keys;

  // The whole screen: moving the pointer shows the overlay, so its buttons can be clicked; the wheel sets the volume.
  usePointerTarget({
    node: focus.root,
    onHover: (pt) => { if (pt) bump(); },
    onClick: () => bump(),
    onWheel: (dy) => {
      if (dy !== 0) volumeStep(dy < 0 ? 1 : -1);
      return true;
    },
  });

  // ---- reactions ----

  // A (re)start that reaches 'playing': re-apply the remembered tracks at once (the tick catches a quick reopen).
  createEffect(on(() => status()?.kind, (kind) => {
    setLatch(coverLatch(latch(), kind));
    if (kind === 'playing' && latch().armed) {
      catchup.everPlayed = true;
      tracks.applyTracks();
      // Ready before the menu opens (a Source row appearing under the focus would move the rows).
      options.loadVersions();
    }
  }));

  // Catch-up: an end right after the open with no frame is Not available; any other end shows the end card.
  createEffect(on(ended, (isEnded) => {
    if (!cu || !isEnded) return;
    if (notAvailableFailure({ kind: 'ended' }, catchup.everPlayed, Date.now() - catchup.openedWall)) catchup.showNotAvailable();
    else catchup.showEndCard();
  }));

  // Catch-up: a first open the source answered with 404/410/400/5xx (both forms) is Not available.
  createEffect(on(() => failed(), (f) => {
    if (!cu || !f) return;
    if (notAvailableFailure(f, catchup.everPlayed, Date.now() - catchup.openedWall)) catchup.showNotAvailable(f.httpStatus);
  }));

  // Ended: save the end position; offer the next episode, else return to the detail.
  createEffect(on(ended, (isEnded) => {
    if (cu || !isEnded || endedHandled) return;
    endedHandled = true;
    dropSeek();
    const d = knownDuration(c.trustedDur(), p.durationMs);
    if (d !== undefined) c.save(d);
    tracks.closePicker();
    if (p.next && p.series) episodes.startCountdown();
    else queueMicrotask(() => { if (c.alive) leave(false); });
  }));

  // A failure with a Try again button takes the focus; any other failure leaves it on the root (Back still works).
  createEffect(on(() => failed()?.reason, (reason) => {
    if (reason === undefined || notAvail()) return;
    dropSeek();
    tracks.closePicker();
    if (reason !== 'unsupported') focusCard();
    else focusRoot();
  }));

  // A loaded subtitle file showing: its cue is looked up from the playhead (no engine track carries it).
  createEffect(() => {
    const ext = sub.external();
    if (!sub.extOn() || !ext) return;
    const show = () => {
      const at = c.trustedPos();
      // A positive delay shows each cue later: look up the cue for that much earlier; the speed fixes frame-rate drift.
      sub.setCue(at === undefined || !Number.isFinite(at) ? '' : cueText(cueAt(ext.cues, subtitleTime(at, sub.subDelay(), sub.subSpeed()))));
    };
    show();
    const timer = setInterval(show, EXT_SUB_POLL_MS);
    onCleanup(() => clearInterval(timer));
  });

  // The overlay hid while its bar had the focus: give it back to the root (focus is never on a hidden node).
  createEffect(on(visible, (v) => {
    if (!v && focus.controlsFocused() && !tracks.pickerOpen() && !options.optionsPage()) focusRoot();
  }));

  // ---- lifecycle ----

  onMount(() => {
    playback.setRect('fullscreen');
    playback.playVod(p, startMs);
    focus.focusRootNow();

    const tick = setInterval(() => {
      c.setNow(Date.now());
      const at = c.trustedPos();
      if (at !== undefined && Number.isFinite(at)) {
        c.setPos(at);
        c.lastPos = at;
      }
      const d = knownDuration(c.trustedDur(), p.durationMs);
      c.setDur(d);
      c.setBufEnd(d === undefined ? undefined : bufferedEndMs(at ?? c.pos(), playback.bufferedAheadMs(), d));
      c.setPaused(playback.paused());
      // A new engine attempt plays (a quick reopen may never leave 'playing'): re-apply the remembered tracks.
      const playing = status()?.kind === 'playing';
      tracks.tick(playing);
      // A loaded file without a speed: set it once the engine reports the video's frame rate.
      if (playing) sub.tickAutoSpeed();
      // Where the engine reports no frame rate it is measured once playing: ask early, so a search has it.
      if (playing) sub.primeFps();
      // Arm progress saves as soon as the start seek has landed.
      if (!c.saveArmed) c.arm();
      // Catch-up: the programme's end reached (the archive may run on into the next one, or reach live).
      if (cu && playing && at !== undefined && d !== undefined && at >= d) catchup.showEndCard();
      // A silent picture (a sound format this device cannot decode): say so once instead of playing on in silence.
      if (!soundWarned && playing && !playback.paused() && playback.soundUndecodable()) {
        soundWarned = true;
        showToast(noSoundText(playback.audioTracks().length));
      }
      // Dolby Vision without a base layer on a display without DV (Samsung): say so once, as the picture starts.
      if (!dvWarned && playing && dvColoursWarning(p.video, player.streamInfo(), DV5)) {
        dvWarned = true;
        showToast(DV_COLOURS_TEXT);
      }
      if (infoOn() && tracks.shapeTicks() % 4 === 0) setInfoTick((v) => v + 1);
      sub.syncTick(at, playing, tracks.shapeTicks());
    }, TICK_MS);
    const saver = setInterval(() => {
      if (status()?.kind === 'playing' && !playback.paused()) c.save();
    }, PROGRESS_SAVE_MS);
    // Hidden: save and pause; visible again stays paused until the user presses Ok.
    const onVisibility = () => {
      if (!document.hidden) return;
      c.save();
      if (pauseOnHidden({ hidden: true, paused: playback.paused(), problem: failed() !== undefined || ended() })) {
        playback.pause();
        c.setPaused(playback.paused());
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    // A released Left/Right ends the hold run (the next press steps 10 s again).
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === 'Left' || e.key === 'Right') seek.endHold(); };
    document.addEventListener('keyup', onKeyUp);
    const offKeys = onLogicalKey(() => bump());
    const offSubs = playback.onSubtitle((text) => {
      if (!c.alive) return;
      if (!sub.extOn()) {
        sub.setCue(cueText(text));
        tracks.cueLangs.add(text, () => playback.textTracks().find((t) => t.active));
      }
      else sub.syncCue(text !== null && text.trim() !== '', c.trustedPos);
    });
    // The subtitles loaded earlier for this title: shown when chosen (the tracks may already have been applied).
    // Catch-up keeps no subtitles of its own.
    if (!cu) api.onlineSubtitlesAvailable().then((ok) => { if (c.alive) finder.setOnlineOk(ok); }, () => { /* not offered */ });
    if (!cu) api.getSubtitle(p.itemId).then((loaded) => {
      if (!c.alive || !loaded) return;
      sub.useLoaded(loaded);
      if (chosen.subtitle === SUBTITLE_KEY_EXT) tracks.applySubtitle();
    }, (err) => console.warn('Subtitle read failed', errName(err)));
    onCleanup(() => {
      clearInterval(tick);
      clearInterval(saver);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('keyup', onKeyUp);
      offKeys();
      offSubs();
    });
  });

  onCleanup(() => {
    c.alive = false;
    dropSeek();
    catchup.dispose();
    tracks.disposeTimer();
    episodes.dispose();
    // A delay changed just before leaving: save it now.
    sub.flushDelay();
    tracks.disposePicker();
    finder.dispose();
    router.removeOverlay(INFO_ID);
    options.dispose();
    c.stopOurs();
  });

  // ---- drawing ----

  const title = oneSpace(p.title);
  const label = p.episodeLabel ? oneSpace(p.episodeLabel) : '';
  /**
   * The card's text (the failure: its cause and status, spec 2026-10-16-source-retry §2.8; else the next-episode
   * countdown) and the box it fits (body size, up to three lines for a long refusal that names the account's limit).
   */
  const card = createMemo(() => {
    const f = failed();
    const text = notAvail() ? CATCHUP_COPY.notAvailable
      : endCard() ? VOD_COPY.endOf(title)
        : f
          ? failureText({ reason: f.reason, httpStatus: f.httpStatus, maxConnections: activeMaxConnections() })
          : nextCardText(oneSpace(p.next?.label ?? ''), episodes.countdown() ?? 0);
    return { text, box: MESSAGE_BOXES.vodCard };
  });
  useNotice(() => {
    const s = vodStatusText(status());
    return s && !failed() && !notAvail() && !endCard() ? { id: 'vod-status', kind: 'wait', text: s, spinner: false } : undefined;
  });

  return (
    <View ref={focus.rootRef} width={LAYOUT.width} height={LAYOUT.height}
      onBack={onBack} onEnter={onEnter}
      onLeft={() => keys.rootScrub('Left')} onRight={() => keys.rootScrub('Right')}
      onUp={focus.focusTimeline} onDown={focus.focusTimeline}
      onPlayPause={() => (failed() || ended() ? true : seek.togglePause())}
      onPlay={() => keys.mediaKey('Play')} onPause={() => keys.mediaKey('Pause')} onStop={() => keys.mediaKey('Stop')}
      onFastForward={() => keys.mediaKey('FastForward')} onRewind={() => keys.mediaKey('Rewind')}
      onChannelUp={episodes.nextNow} onChannelDown={episodes.prevNow} onInfo={toggleInfo} onMenu={options.openOptions}>

      {/* Under everything (subtitles 5, overlay 10, cards 30): hides what sits on the video plane until the first picture. */}
      <Show when={coverVideo(status(), played(), latch().armed)}>
        <View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.background} zIndex={1} />
      </Show>

      <Show when={infoOn()}>
        <KeyValuePanel x={LAYOUT.safeX} y={LAYOUT.safeY} width={600} title={PLAYER_COPY.streamInfo} lines={infoLines()} framed />
      </Show>

      <SubtitleCue cue={sub.cue()} overlayShown={visible()} />

      <VodControls visible={visible()} title={title} label={label} badges={badges()}
        posMs={c.pos()} durMs={c.dur()} bufferedEndMs={c.bufEnd()} scrub={c.scrub()} now={c.now()} paused={c.paused()} hasNext={Boolean(p.next)}
        catchup={cu ? (c.cur() ?? cu) : undefined} catchupDurMs={p.durationMs}
        timelineRef={focus.timelineRef} barRef={focus.barRef}
        onScrubKey={seek.scrubKey} onTimelineEnter={keys.onTimelineEnter} onTimelineDown={focus.focusBar} onTimelineFocus={focus.onTimelineFocus}
        onPointerSeek={seek.pointerSeek} onDrag={seek.onDrag} onActive={bump}
        onAction={keys.onAction} onBarUp={focus.focusTimeline} onBarFocus={focus.onBarFocus} />

      <VodCard shown={Boolean(notAvail() || endCard() || failed() || (episodes.countdown() !== undefined && p.next))}
        card={card()} withActions={notAvail() || endCard() || failed()?.reason !== 'unsupported'}
        actions={cardActions({ notAvail: notAvail(), endCard: endCard(), next: c.cur()?.next, failed: failed() !== undefined })}
        onAction={keys.onCardAction} actionsRef={focus.cardRef} />

      {/* Desktop volume: + and - keys and the wheel; with the controls hidden a change shows a short top-right pill. */}
      <VolumeOsd inBar={visible()} />

      <VodSheets sub={sub} tracks={tracks} options={options} finder={finder} />
    </View>
  );
}
