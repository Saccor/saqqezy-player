import { createSignal, type Accessor } from 'solid-js';
import type { PlayableChannel, VodPlayable } from '@iptv/app-api';
import type { Player, PlaybackSupervisor, Rect, SupervisorStatus, TrackInfo } from '@iptv/player';

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
  playVod(p: VodPlayable, startMs: number): void;
  pause(): void;
  resume(): void;
  /** Absolute position in ms (clamped by the supervisor to [0, duration - 1 s]). */
  seek(ms: number): void;
  /** The current VOD title's playhead; undefined unless that title was actually opened (not while held, not for live). */
  positionMs(): number | undefined;
  /** As `positionMs`: undefined unless the current VOD title was opened. */
  durationMs(): number | undefined;
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

/** The active source's refusal cooldown, as the controller sees it (the worker owns the state). */
export interface CooldownGate {
  /** True while nothing may be sent to the active source. */
  blocked(): boolean;
  /** The supervisor gave up because the source refused the stream. */
  refused(sourceKey: string): void;
  /** A stream played: the source answers us. */
  answered(sourceKey: string): void;
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
  player: Pick<Player, 'setRect' | 'audioTracks' | 'selectAudioTrack' | 'textTracks' | 'selectTextTrack'>,
  supervisor: Pick<PlaybackSupervisor, 'play' | 'stop' | 'onStatus' | 'pause' | 'resume' | 'seek' | 'positionMs' | 'durationMs' | 'paused' | 'startedAttempts' | 'onSubtitle'>,
  onStatusChange: (s: SupervisorStatus | undefined) => void = () => { /* no listener */ },
  kind: PlayerKind = 'HTML5',
  sourceKey: () => string | undefined = () => undefined,
  gate?: CooldownGate,
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
  let answeredReported = false;
  supervisor.onStatus((s) => {
    report(s);
    const key = playKey;
    if (key === undefined || !gate) return;
    if (s.kind === 'playing' && !answeredReported) {
      answeredReported = true;
      gate.answered(key);
    } else if (s.kind === 'failed') {
      playKey = undefined;
      if (s.reason === 'refused') gate.refused(key);
    }
  });
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
  const startPlay = (url: string, alt: string | undefined, opts: { channel?: string; vod?: boolean; startMs?: number }) => {
    held = false;
    const key = sourceKey();
    playKey = key;
    answeredReported = false;
    vodOpened = opts.vod === true;
    supervisor.play(url, alt, { sourceKey: key, ...opts });
  };

  const hold = () => {
    updateVodStart();
    held = true;
    playKey = undefined;
    supervisor.stop();
    report(undefined);
  };

  return {
    playChannel(ch) {
      const cur = current();
      if (cur?.id === ch.id && !held && status()?.kind !== 'failed') {
        // Same stream: keep it running, but take the fresh info (a rename, now/next). The urls stay those of
        // the open stream.
        if (cur !== ch) {
          const next: PlayableChannel = { ...ch, url: cur.url };
          if (cur.alternateUrl !== undefined) next.alternateUrl = cur.alternateUrl;
          else delete next.alternateUrl;
          setCurrent(next);
        }
        return false;
      }
      pendingVod = undefined;
      vodOpened = false;
      setCurrent(ch);
      if (gate?.blocked()) {
        hold();
        return false;
      }
      startPlay(ch.url, ch.alternateUrl, { channel: ch.name });
      return true;
    },
    playVod(p, startMs) {
      token++;
      const stand: PlayableChannel = { id: 'vod:' + p.itemId, number: 0, name: '', group: '', favourite: false, url: p.url };
      pendingVod = { p, startMs };
      vodOpened = false;
      setCurrent(stand);
      if (gate?.blocked()) {
        hold();
        return;
      }
      startPlay(p.url, undefined, { vod: true, startMs });
    },
    pause: () => supervisor.pause(),
    resume: () => supervisor.resume(),
    seek: (ms) => supervisor.seek(ms),
    // Only the opened title's: a held (never opened) VOD must not read the previous title's leftovers.
    positionMs: () => (pendingVod && vodOpened ? supervisor.positionMs() : undefined),
    durationMs: () => (pendingVod && vodOpened ? supervisor.durationMs() : undefined),
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
    stop() {
      token++;
      held = false;
      pendingVod = undefined;
      vodOpened = false;
      playKey = undefined;
      supervisor.stop();
      setCurrent(undefined);
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
