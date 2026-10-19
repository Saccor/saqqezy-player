import { createSignal, type Accessor } from 'solid-js';
import type { PlayableChannel, VodPlayable } from '@iptv/app-api';
import { onHidden, onVisible, type BackgroundAction } from './backgroundPolicy.ts';
import type { Player, PlaybackSupervisor, Rect, StreamHeaders, SupervisorStatus, TrackInfo } from '@iptv/player';

export interface PlaybackController {
  /**
   * Plays `ch` through the supervisor (which stops the old stream before opening the next). Returns false when
   * `ch` is already the current channel and has not failed: the stream keeps running, so moving from the
   * preview to fullscreen never reconnects; only `current`'s info (name, now/next) is refreshed from `ch`.
   */
  playChannel(ch: PlayableChannel): boolean;
  /**
   * The source just entered its refusal cooldown: a stream that is not playing (loading, reconnecting, or refused) is
   * stopped, so no retry reaches the source, while one that plays keeps playing. The channel stays current and is
   * held: `resumeHeld` (or the next `playChannel`) opens it once the cooldown allows it. A VOD title that ended or
   * failed is left alone: nothing is loading, and its next-episode or error card stays.
   */
  holdForCooldown(): void;
  /** The cooldown ended (a wait ran out, or Retry): opens the channel it held back, if any. */
  resumeHeld(): void;
  /**
   * VOD: plays a finite title from `startMs`. `current` becomes a stand-in channel (`vod:<itemId>`, empty name: no
   * titles reach the playback journal). No live-delay logic; the open-rate cap and refusal cooldown still apply.
   */
  playVod(p: VodPlayable, startMs: number, automatic?: boolean): void;
  pause(): void;
  resume(): void;
  /** Absolute position in ms (clamped by the supervisor to [0, duration - 1 s]). */
  seek(ms: number): void;
  /** The current VOD title's playhead; undefined unless that title was actually opened (not while held, not for live). */
  positionMs(): number | undefined;
  /** As `positionMs`: undefined unless the current VOD title was opened. */
  durationMs(): number | undefined;
  /** Ms buffered ahead of the playhead, as `positionMs`: undefined unless the current VOD title was opened. */
  bufferedAheadMs(): number | undefined;
  /** As `positionMs`: false unless the current VOD title was opened. Its picture plays but the device decodes no sound. */
  soundUndecodable(): boolean;
  paused(): boolean;
  /** Attempts that reached their first frame (never reset): a new value means a new engine attempt is playing. */
  startedAttempts(): number;
  /** Subtitle cues from engines that cannot draw them; returns the unsubscribe function. */
  onSubtitle(fn: (text: string | null) => void): () => void;
  audioTracks(): TrackInfo[];
  selectAudioTrack(id: string): void;
  textTracks(): TrackInfo[];
  /** `null`: subtitles off. */
  selectTextTrack(id: string | null): void;
  /**
   * The app went to the background (Tizen multitasking). Live: the stream is closed, the channel stays current. VOD:
   * the engine suspends and remembers the position. Nothing playing (or held by a cooldown): nothing happens.
   */
  suspendForBackground(): void;
  /**
   * Back in the foreground. Live reopens (or waits for `networkBack` when `networkUp` is false); VOD asks the engine to
   * restore and reopens at the saved position when it cannot.
   */
  resumeFromBackground(s: { networkUp: boolean }): void;
  /** The network is back: reopens the live channel that was waiting for it, once. */
  networkBack(): void;
  /** Stops the stream and supersedes every pending request (see `begin`). */
  stop(): void;
  /**
   * Starts a play request and returns its token; a later `begin()` or `stop()` supersedes it. Callers that
   * await something (e.g. `getPlayable`) before `playChannel` check `isLatest(token)` first, so a slow answer
   * for an older request never replaces the channel the user asked for since.
   */
  begin(): number;
  isLatest(token: number): boolean;
  /** Moves the video only; never touches the stream. */
  setRect(rect: Rect | 'fullscreen'): void;
  /** True while the last `setRect` covered the whole screen (false until a screen asks for fullscreen). */
  rectIsFullscreen: Accessor<boolean>;
  /** Which player is active ("AVPlay" on a Samsung TV, else "HTML5"); shown in Diagnostics so a silent fallback is visible. */
  playerKind(): PlayerKind;
  status: Accessor<SupervisorStatus | undefined>;
  current: Accessor<PlayableChannel | undefined>;
}

export type PlayerKind = 'AVPlay' | 'HTML5';

/** What the gate needs of a stream: its URL and its host's cooldown key and seed (from the worker). */
export type CooldownStream = Pick<PlayableChannel, 'url' | 'cooldownKey' | 'cooldown'>;

/** The refusal cooldown, as the controller sees it (the worker owns the state). */
export interface CooldownGate {
  /** True while nothing may be sent for this stream: its host or the active source is cooling down. */
  blocked(stream: CooldownStream): boolean;
  /**
   * The supervisor gave up because the source refused the stream at `url` (only its host pauses). `retryAfterMs`: the
   * status probe's `Retry-After`, which replaces the wait.
   */
  refused(sourceKey: string, url: string, retryAfterMs?: number): void;
  /** The stream at `url` played: its host and the source answer us. */
  answered(sourceKey: string, url: string): void;
  /** The current stream changed (undefined: none): the cooldown copy and the hold follow its host. */
  current?(stream: CooldownStream | undefined): void;
}

const DESIGN_W = 1920;
const DESIGN_H = 1080;

function coversScreen(rect: Rect | 'fullscreen'): boolean {
  return rect === 'fullscreen' || (rect.x <= 0 && rect.y <= 0 && rect.x + rect.w >= DESIGN_W && rect.y + rect.h >= DESIGN_H);
}

/**
 * Testable core of the `playback` singleton: one player, one supervisor, two signals. `sourceKey` returns the
 * active source id (opaque, never a URL); it keys the learned live delay and the cooldown reports. `gate` keeps
 * streams closed while the source is in its refusal cooldown and reports how the source answered each play.
 */
export function createPlaybackController(
  player: Pick<Player, 'setRect' | 'audioTracks' | 'selectAudioTrack' | 'textTracks' | 'selectTextTrack' | 'soundUndecodable' | 'suspend' | 'resume'>,
  supervisor: Pick<PlaybackSupervisor, 'play' | 'stop' | 'onStatus' | 'pause' | 'resume' | 'seek' | 'positionMs' | 'durationMs' | 'paused' | 'startedAttempts' | 'onSubtitle' | 'liveInfo'>,
  onStatusChange: (s: SupervisorStatus | undefined) => void = () => { /* no listener */ },
  kind: PlayerKind = 'HTML5',
  sourceKey: () => string | undefined = () => undefined,
  gate?: CooldownGate,
  /** Told how a return from the background was handled (the playback journal). */
  onResumed: (what: 'resume_restore' | 'resume_reopen') => void = () => { /* no listener */ },
): PlaybackController {
  const [status, setStatus] = createSignal<SupervisorStatus | undefined>(undefined);
  const [current, setCurrent] = createSignal<PlayableChannel | undefined>(undefined);
  const [rectIsFullscreen, setRectIsFullscreen] = createSignal(false);
  const report = (s: SupervisorStatus | undefined) => {
    setStatus(s);
    onStatusChange(s);
  };
  /** The current channel was not opened (cooldown): the same channel must still open later. */
  let held = false;
  /** Source of the stream opened by the last play (its first frame and a refusal at any time are reported). */
  let playKey: string | undefined;
  /** That stream's URL: reports name its host (the worker derives the key; never logged). */
  let playUrl = '';
  /** The play's URLs in the supervisor's order (primary, then the alternate): a refusal names one by index. */
  let playUrls: string[] = [];
  let answeredReported = false;
  supervisor.onStatus((s) => {
    report(s);
    const key = playKey;
    if (key === undefined || !gate) return;
    if (s.kind === 'playing' && !answeredReported) {
      answeredReported = true;
      gate.answered(key, playUrl);
    } else if (s.kind === 'failed') {
      playKey = undefined;
      // Only refusals: a stream that failed otherwise never counts toward the unreachable breaker (spec §5).
      // The cooldown lands on the host of the URL the source refused (the alternate may live on another host).
      if (s.reason === 'refused') gate.refused(key, playUrls[s.urlIndex ?? 0] ?? playUrl, s.retryAfterMs);
    }
  });
  /**
   * Sets the current channel and publishes its stream to the gate. Callers publish only after they decided between
   * hold and open and updated `held`: publishing can run the shell's cooldown effect synchronously (resumeHeld), which
   * must find this call's decision already made, or the channel would open twice.
   */
  const setCurrentStream = (ch: PlayableChannel | undefined) => {
    setCurrent(ch);
    gate?.current?.(ch);
  };
  let token = 0;

  /** The VOD request in flight (also while held by the cooldown): a held title resumes as VOD, never as live. */
  let pendingVod: { p: VodPlayable; startMs: number } | undefined;
  /** True only once `startPlay` opened the pending VOD: only then is the supervisor's position this title's. */
  let vodOpened = false;
  /** Folds the playhead of the opened title into the pending request's start (never goes backwards). */
  const updateVodStart = () => {
    if (!pendingVod || !vodOpened) return;
    const pos = supervisor.positionMs();
    if (pos !== undefined && pos > pendingVod.startMs) pendingVod.startMs = pos;
  };
  const startPlay = (
    url: string, alt: string | undefined, opts: { channel?: string; vod?: boolean; startMs?: number; automatic?: boolean }, headers?: StreamHeaders,
  ) => {
    held = false;
    const key = sourceKey();
    playKey = key;
    playUrl = url;
    playUrls = alt === undefined ? [url] : [url, alt];
    answeredReported = false;
    vodOpened = opts.vod === true;
    // Headers only when the stream has some: the engines apply what they can (AVPlay: the User-Agent). Never logged.
    supervisor.play(url, alt, headers ? { sourceKey: key, ...opts, headers } : { sourceKey: key, ...opts });
  };

  const hold = () => {
    updateVodStart();
    held = true;
    playKey = undefined;
    supervisor.stop();
    report(undefined);
  };

  let away: BackgroundAction = { kind: 'none' };
  let waitingNetwork = false;
  /** Between `suspendForBackground` and `resumeFromBackground`: nothing opens by itself. */
  let inBackground = false;
  /** The VOD title was paused by the user when the app went away. */
  let vodWasPaused = false;
  /** Opens the current live channel again, through the same hold/cooldown decision as `playChannel`. */
  const reopenLive = () => {
    const cur = current();
    if (!cur || pendingVod) return;
    if (gate?.blocked(cur)) {
      hold();
      return;
    }
    // Not the user's open: it waits for room under the source's open rate and counts against it.
    startPlay(cur.url, cur.alternateUrl, { channel: cur.name, automatic: true }, cur.headers);
    onResumed('resume_reopen');
  };

  return {
    playChannel(ch) {
      const cur = current();
      if (cur?.id === ch.id && !held && !waitingNetwork && status()?.kind !== 'failed') {
        // Same stream: keep it running, but take the fresh info (a rename, now/next). The urls stay those of
        // the open stream.
        if (cur !== ch) {
          const next: PlayableChannel = { ...ch, url: cur.url };
          if (cur.alternateUrl !== undefined) next.alternateUrl = cur.alternateUrl;
          else delete next.alternateUrl;
          setCurrentStream(next);
        }
        return false;
      }
      pendingVod = undefined;
      vodOpened = false;
      waitingNetwork = false;
      setCurrent(ch);
      // Decide (and update `held`) before publishing the new stream's host: see setCurrentStream.
      if (gate?.blocked(ch)) {
        hold();
        gate.current?.(ch);
        return false;
      }
      startPlay(ch.url, ch.alternateUrl, { channel: ch.name }, ch.headers);
      gate?.current?.(ch);
      return true;
    },
    playVod(p, startMs, automatic) {
      token++;
      const stand: PlayableChannel = { id: 'vod:' + p.itemId, number: 0, name: '', group: '', favourite: false, url: p.url };
      if (p.cooldownKey !== undefined) stand.cooldownKey = p.cooldownKey;
      if (p.cooldown !== undefined) stand.cooldown = p.cooldown;
      pendingVod = { p, startMs };
      vodOpened = false;
      waitingNetwork = false;
      setCurrent(stand);
      // Decide (and update `held`) before publishing the new stream's host: see setCurrentStream.
      if (gate?.blocked(stand)) {
        hold();
        gate.current?.(stand);
        return;
      }
      startPlay(p.url, undefined, automatic ? { vod: true, startMs, automatic } : { vod: true, startMs }, p.headers);
      gate?.current?.(stand);
    },
    pause: () => supervisor.pause(),
    resume: () => supervisor.resume(),
    seek: (ms) => supervisor.seek(ms),
    // Only the opened title's: a held (never opened) VOD must not read the previous title's leftovers.
    positionMs: () => (pendingVod && vodOpened ? supervisor.positionMs() : undefined),
    durationMs: () => (pendingVod && vodOpened ? supervisor.durationMs() : undefined),
    bufferedAheadMs: () => {
      const s = pendingVod && vodOpened ? supervisor.liveInfo().bufferAheadS : undefined;
      return s === undefined ? undefined : s * 1000;
    },
    soundUndecodable: () => (pendingVod && vodOpened ? player.soundUndecodable?.() ?? false : false),
    paused: () => supervisor.paused(),
    startedAttempts: () => supervisor.startedAttempts(),
    onSubtitle: (fn) => supervisor.onSubtitle(fn),
    audioTracks: () => player.audioTracks(),
    selectAudioTrack: (id) => player.selectAudioTrack(id),
    textTracks: () => player.textTracks?.() ?? [],
    selectTextTrack: (id) => player.selectTextTrack?.(id),
    holdForCooldown() {
      const kind = status()?.kind;
      if (pendingVod && (kind === 'ended' || kind === 'failed')) return;
      if (current() !== undefined && !held && kind !== 'playing') hold();
    },
    resumeHeld() {
      if (!held) return;
      const v = pendingVod;
      if (v) {
        updateVodStart();
        this.playVod(v.p, v.startMs);
        return;
      }
      const cur = current();
      if (cur) this.playChannel(cur);
    },
    suspendForBackground() {
      inBackground = true;
      if (waitingNetwork) {
        // Closed already and waiting for the network: still closed, and it reopens only after coming back.
        waitingNetwork = false;
        away = { kind: 'close-live' };
        return;
      }
      const kind = status()?.kind;
      const live = !pendingVod && current() !== undefined && kind !== undefined && kind !== 'failed';
      const playing = held ? 'none' : pendingVod ? (vodOpened ? 'vod' : 'none') : live ? 'live' : 'none';
      away = onHidden({ playing, positionMs: supervisor.positionMs() });
      if (away.kind === 'close-live') {
        supervisor.stop();
        playKey = undefined;
        report(undefined); // nothing plays now: the UI must not show "playing" over a black plane
      } else if (away.kind === 'suspend-vod') {
        vodWasPaused = supervisor.paused();
        player.suspend?.();
      }
    },
    resumeFromBackground(s) {
      inBackground = false;
      const next = onVisible(away, s);
      away = { kind: 'none' };
      if (next.kind === 'reopen-live') {
        reopenLive();
      } else if (next.kind === 'wait-network') {
        waitingNetwork = true;
      } else if (next.kind === 'resume-vod') {
        if (player.resume?.() ?? false) {
          onResumed('resume_restore');
        } else if (pendingVod) {
          onResumed('resume_reopen');
          this.playVod(pendingVod.p, next.positionMs, true);
          // A paused title stays paused: the supervisor pauses it at its first frame.
          if (vodWasPaused) supervisor.pause();
        }
      }
    },
    networkBack() {
      if (!waitingNetwork || inBackground) return;
      waitingNetwork = false;
      reopenLive();
    },
    stop() {
      token++;
      waitingNetwork = false;
      inBackground = false;
      away = { kind: 'none' };
      held = false;
      pendingVod = undefined;
      vodOpened = false;
      playKey = undefined;
      supervisor.stop();
      setCurrentStream(undefined);
      report(undefined);
    },
    begin: () => ++token,
    isLatest: (t) => t === token,
    setRect: (rect) => {
      player.setRect(rect);
      setRectIsFullscreen(coversScreen(rect));
    },
    rectIsFullscreen,
    playerKind: () => kind,
    status,
    current,
  };
}
