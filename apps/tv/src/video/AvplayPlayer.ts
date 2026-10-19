import type {
  AspectMode, LiveProfile, MediaCapsProbe, OpenOptions, PlaybackHealth, Player, PlayerState, Rect, StateDetail, StreamInfo, TrackInfo,
} from '@iptv/player';
import { audioCodecOf, staticCaps } from '@iptv/player';
import { createScreenSaverGuard } from '../platform/screenSaverGuard.ts';
import { adaptiveInfo, type PanelCaps } from './adaptiveInfo.ts';
import { avplayBuffering } from './engineConfig.ts';
import { DESIGN_HEIGHT, DESIGN_WIDTH, FULLSCREEN } from './videoLayer.ts';

/** What the research documents for AVPlay on Tizen (DTS and TrueHD are `none` since 2018). */
const TIZEN_CAPS = staticCaps('tizen', 'avplay');

/** The part of Samsung's `webapis.avplay` this player uses (injected, so it is testable without a TV). */
export interface AvplayLike {
  open(url: string): void;
  close(): void;
  prepareAsync(success?: () => void, error?: (e: unknown) => void): void;
  play(): void;
  stop(): void;
  setListener(listener: AvplayListener): void;
  setDisplayRect(x: number, y: number, width: number, height: number): void;
  setDisplayMethod(method: string): void;
  getCurrentTime(): number;
  getTotalTrackInfo(): AvplayTrack[];
  setSelectTrack(type: string, index: number): void;
  getCurrentStreamInfo(): AvplayTrack[];
  setBufferingParam?(option: string, unit: string, amount: number): void;
  setTimeoutForBuffering?(seconds: number): void;
  setStreamingProperty?(type: string, value: string): void;
  getStreamingProperty?(type: string): string;
  seekTo?(ms: number, success?: () => void, error?: (e: unknown) => void): void;
  setVideoStillMode?(mode: 'true' | 'false'): void;
  pause?(): void;
  /** 'NONE' | 'IDLE' | 'READY' | 'PLAYING' | 'PAUSED'. */
  getState?(): string;
  /** ms; 0 (or less) while unknown. */
  getDuration?(): number;
  /** true hides the subtitles. */
  setSilentSubtitle?(silent: boolean): void;
  /** Releases the decoder and network while the app is hidden (Tizen multitasking). */
  suspend?(): void;
  /** Re-opens after `suspend()`: `resumeMs` start position; `bPrepare` false lets AVPlay prepare itself. */
  restore?(url: string, resumeMs: number, bPrepare: boolean): void;
}

export interface AvplayListener {
  onbufferingstart?: () => void;
  onbufferingprogress?: (percent: number) => void;
  onbufferingcomplete?: () => void;
  oncurrentplaytime?: (ms: number) => void;
  onevent?: (type: string, data: string) => void;
  onerror?: (type: string) => void;
  onstreamcompleted?: () => void;
  /** Subtitle cue: `(duration, text, data3, data4)`. */
  onsubtitlechange?: (duration: unknown, text: unknown, data3?: unknown, data4?: unknown) => void;
}

/** `extra_info` is a JSON string, e.g. `{"fourCC":"H264","Width":"1920","Height":"1080"}`. */
export interface AvplayTrack { index: number; type: string; extra_info: string }

export type AvplayDisplayMethod =
  | 'PLAYER_DISPLAY_MODE_LETTER_BOX'
  | 'PLAYER_DISPLAY_MODE_FULL_SCREEN'
  | 'PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO';

export interface Size { w: number; h: number }

const DESIGN: Size = { w: DESIGN_WIDTH, h: DESIGN_HEIGHT };
const FULL: Rect = FULLSCREEN;
const FORCED_RATIO: Partial<Record<AspectMode, number>> = { '16:9': 16 / 9, '4:3': 4 / 3 };

/**
 * Where the video goes and how AVPlay scales it, for a design-space (1920x1080) rect:
 * - `auto`: the rect, AUTO_ASPECT_RATIO (source aspect, fitted).
 * - `stretch`: the rect, FULL_SCREEN (fills it).
 * - `16:9` / `4:3`: a centred box of that ratio contained in the rect, FULL_SCREEN (picture forced to the ratio).
 * - `zoom`: in full screen, a centred box of the source ratio (16:9 if unknown) that covers the screen,
 *   LETTER_BOX; what spills past is cropped by the screen edge. In any smaller rect (the Home/Guide preview)
 *   it falls back to `auto`, because the overflow would be drawn outside the box.
 * The result is converted to `space` (AVPlay's display coordinates) and rounded.
 */
export function avplayDisplay(
  rect: Rect, aspect: AspectMode, space: Size, sourceAspect?: number,
): Rect & { method: AvplayDisplayMethod } {
  let r: Rect = rect;
  let method: AvplayDisplayMethod = 'PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO';
  const forced = FORCED_RATIO[aspect];
  if (aspect === 'stretch') {
    method = 'PLAYER_DISPLAY_MODE_FULL_SCREEN';
  } else if (forced !== undefined) {
    method = 'PLAYER_DISPLAY_MODE_FULL_SCREEN';
    r = fitRatio(rect, forced, 'contain');
  } else if (aspect === 'zoom' && isFullscreen(rect)) {
    method = 'PLAYER_DISPLAY_MODE_LETTER_BOX';
    const ratio = sourceAspect !== undefined && Number.isFinite(sourceAspect) && sourceAspect > 0 ? sourceAspect : 16 / 9;
    r = fitRatio(rect, ratio, 'cover');
  }
  const sx = space.w / DESIGN.w;
  const sy = space.h / DESIGN.h;
  return {
    x: Math.round(r.x * sx), y: Math.round(r.y * sy), w: Math.round(r.w * sx), h: Math.round(r.h * sy), method,
  };
}

function isFullscreen(r: Rect): boolean {
  return r.x <= 0 && r.y <= 0 && r.x + r.w >= DESIGN.w && r.y + r.h >= DESIGN.h;
}

function fitRatio(rect: Rect, ratio: number, mode: 'contain' | 'cover'): Rect {
  const wider = rect.w / rect.h > ratio;
  // contain: limited by the short side; cover: by the long side.
  const byHeight = mode === 'contain' ? wider : !wider;
  const w = byHeight ? rect.h * ratio : rect.w;
  const h = byHeight ? rect.h : rect.w / ratio;
  return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h };
}

/** The AVPlay error's own name (a string event, or the `name` of an error object); '' when there is none. */
export function avplayErrorName(e: unknown): string {
  return typeof e === 'string'
    ? e
    : typeof e === 'object' && e !== null && typeof (e as { name?: unknown }).name === 'string'
      ? (e as { name: string }).name
      : '';
}

/**
 * AVPlay error (an `onerror` type string, or an exception / prepare error with a `name`) to a player code.
 * Unsupported content or DRM is `UNSUPPORTED` (the supervisor tries the other format); player state faults are
 * `MEDIA`; everything else, including unknown shapes, is `NETWORK` so it is retried.
 */
export function mapAvplayError(e: unknown): 'UNSUPPORTED' | 'NETWORK' | 'MEDIA' {
  const name = avplayErrorName(e);
  if (/not_?supported|unsupported|drm/i.test(name)) return 'UNSUPPORTED';
  if (/^PLAYER_ERROR_(INVALID_STATE|INVALID_OPERATION|INVALID_PARAMETER|SEEK_FAILED|GENEREIC|GENERIC)/.test(name)) {
    return 'MEDIA';
  }
  return 'NETWORK';
}

function parseExtra(t: AvplayTrack): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(t.extra_info);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** `IS_LIVE` (undefined: not known, e.g. the query failed) and the `GET_LIVE_DURATION` window (ms) of a live stream. */
interface LiveState { live: boolean | undefined; window?: { start: number; end: number } }

/** One `open()`; once `dead`, nothing it registered may emit again. */
interface Session {
  url: string; attemptId: number | undefined; dead: boolean; started: boolean; sawLive?: boolean;
  watchdog?: ReturnType<typeof setTimeout>;
  /** Guards the VOD start seek: if firmware never calls back, playback starts anyway. */
  seekWatchdog?: ReturnType<typeof setTimeout>;
  /** After `resume()`: no play time within `RESTORE_TIMEOUT_MS` means the restore failed. */
  restoreWatchdog?: ReturnType<typeof setTimeout>;
  /** False when opened as a file/VOD (`open(…, { live: false })`): never live, no live window. */
  live: boolean;
  /** VOD start position (ms), sought once prepared, before `play()`. */
  startMs?: number;
  /** Subtitles turned off with `selectTextTrack(null)`. */
  textOff?: boolean;
}

const MESSAGE = 'Playback error';
const PREPARE_TIMEOUT_MS = 15_000;
/** The VOD start seek gets this long to call back before playback starts anyway. */
const START_SEEK_TIMEOUT_MS = 3_000;
/** After a restore, AVPlay must report play time within this long, or the caller reopens the title. */
const RESTORE_TIMEOUT_MS = 5_000;
/** `getStreamingProperty` is a synchronous bridge call: poll the live window at most this often. */
const LIVE_WINDOW_POLL_MS = 2_000;
/** A VOD seek never lands closer than this to the end (that would end the film at once). */
const SEEK_END_MARGIN_MS = 1_000;
/** A held frame never outlives this (as in Html5Player), so the screensaver cannot stay off over a failure screen. */
const HOLD_MAX_MS = 30_000;

/**
 * `Player` on Samsung's AVPlay (`webapis.avplay`), used on Tizen. AVPlay draws on a video plane beneath the
 * page (an `<object type="application/avplayer">` must be in the document), positioned with `setDisplayRect`.
 * Every AVPlay call is guarded: a throw becomes an `error` state, never an exception. URLs are never logged
 * or put in messages.
 */
export class AvplayPlayer implements Player {
  private readonly listeners = new Set<(s: PlayerState, d?: StateDetail) => void>();
  private readonly subtitleListeners = new Set<(text: string | null) => void>();
  /** Clears the cue on screen once its duration has passed. */
  private cueTimer: ReturnType<typeof setTimeout> | undefined;
  private session: Session | undefined;
  private rect: Rect = FULL;
  private aspect: AspectMode = 'auto';
  private lastPosition = 0;
  private readonly space: Size;
  private profile: LiveProfile = { preset: 'balanced', targetS: 3, allowRate: false };
  private readonly prepareTimeoutMs: number;
  private windowCache: { at: number; value: LiveState } | undefined;
  private stillOn = false;
  private suspended: { url: string; positionMs: number; wasPaused: boolean } | undefined;
  private readonly saver: ReturnType<typeof createScreenSaverGuard> | undefined;
  /** Ends a held frame that outlived playback (see `HOLD_MAX_MS`). */
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private video = false;
  private userPaused = false;

  private readonly panel: PanelCaps | undefined;

  constructor(
    private readonly avplay: AvplayLike,
    opts: { displaySpace?: Size; prepareTimeoutMs?: number; screenSaver?: (s: 'on' | 'off') => void; panel?: PanelCaps } = {},
  ) {
    this.panel = opts.panel;
    this.saver = opts.screenSaver ? createScreenSaverGuard(opts.screenSaver) : undefined;
    this.space = opts.displaySpace ?? DESIGN;
    this.prepareTimeoutMs = opts.prepareTimeoutMs ?? PREPARE_TIMEOUT_MS;
  }

  /** What the panel adds to the static Tizen caps (spec §3.3 item 4); empty without panel facts. */
  capsProbe(): MediaCapsProbe {
    const p = this.panel;
    if (!p) return {};
    const cap = <T>(value: T) => ({ value, evidence: 'probe' as const });
    const hdr = p.hdrTv ? 'decode' : 'none';
    return {
      display: {
        maxHeight: cap(p.eightK ? 4320 : p.uhd ? 2160 : 1080),
        hdr: { hdr10: cap(hdr), hdr10plus: cap(hdr), hlg: cap(hdr) },
      },
    };
  }

  panelCaps(): PanelCaps | undefined {
    return this.panel ? { ...this.panel } : undefined;
  }

  open(url: string, attemptId?: number, opts: OpenOptions = {}): Promise<void> {
    this.stop();
    const s: Session = { url, attemptId, dead: false, started: false, live: opts.live !== false };
    if (!s.live && opts.startMs !== undefined && opts.startMs > 0) s.startMs = opts.startMs;
    this.session = s;
    this.userPaused = false;
    this.lastPosition = 0;
    this.windowCache = undefined;
    this.emit(s, 'loading');
    const av = this.avplay;
    try {
      av.open(url);
      av.setListener({
        onbufferingstart: () => this.emit(s, 'buffering'),
        onbufferingcomplete: () => { if (s.started) this.emit(s, 'playing'); },
        oncurrentplaytime: (ms) => {
          if (s.dead || typeof ms !== 'number') return;
          this.lastPosition = ms;
          clearTimeout(s.restoreWatchdog);
        },
        onerror: (type) => this.emit(s, 'error', { code: mapAvplayError(type), message: MESSAGE, detail: avplayErrorName(type) || undefined }),
        // A cue shows for its `duration` (ms); the next cue, a seek, a track change or stop clears it sooner.
        onsubtitlechange: (duration, text) => {
          if (s.dead || s !== this.session || s.textOff) return;
          this.showCue(typeof text === 'string' && text !== '' ? text : null, Number(duration));
        },
        // A live stream that "completes" has dropped: report it so the supervisor reconnects. A non-live stream
        // simply ended: 'idle', which never reconnects. Unknown (the query failed) keeps the reconnect.
        onstreamcompleted: () => {
          if (s.dead || s !== this.session) return;
          if (!s.live || this.liveState().live === false) this.emit(s, 'idle');
          else this.emit(s, 'error', { code: 'NETWORK', message: MESSAGE, detail: 'streamCompleted' });
        },
      });
      this.applyBuffering(opts.headers?.userAgent);
      this.applyDisplay();
      s.watchdog = setTimeout(() => {
        // Some live HLS streams never call either prepareAsync callback: report it so the supervisor retries.
        if (!s.started) this.emit(s, 'error', { code: 'NETWORK', message: MESSAGE, detail: 'prepareTimeout' });
      }, this.prepareTimeoutMs);
      av.prepareAsync(
        () => {
          clearTimeout(s.watchdog);
          if (s.dead || s !== this.session) return;
          this.applyDisplay(); // the source aspect is known now (zoom); guarded inside
          // VOD resume: seek before the first play; a failed seek plays from the start.
          if (s.startMs !== undefined && av.seekTo) {
            const to = this.clampSeek(s.startMs) ?? s.startMs;
            const go = () => {
              clearTimeout(s.seekWatchdog);
              if (!s.dead && s === this.session && !s.started) this.startPlay(s);
            };
            try {
              s.seekWatchdog = setTimeout(go, START_SEEK_TIMEOUT_MS);
              av.seekTo(to, go, go);
              return;
            } catch {
              clearTimeout(s.seekWatchdog);
              // fall through: play from the start
            }
          }
          this.startPlay(s);
        },
        (e) => {
          clearTimeout(s.watchdog);
          this.emit(s, 'error', { code: mapAvplayError(e), message: MESSAGE, detail: avplayErrorName(e) || undefined });
        },
      );
    } catch (e) {
      this.emit(s, 'error', { code: mapAvplayError(e), message: MESSAGE, detail: avplayErrorName(e) || undefined });
    }
    return Promise.resolve();
  }

  private startPlay(s: Session): void {
    try {
      this.avplay.play();
      s.started = true;
      this.video = true;
      this.releaseLastFrame(); // also refreshes the screensaver
      this.emit(s, 'playing');
    } catch (e) {
      this.emit(s, 'error', { code: mapAvplayError(e), message: MESSAGE, detail: avplayErrorName(e) || undefined });
    }
  }

  stop(): void {
    const s = this.session;
    if (!s) return;
    s.dead = true;
    clearTimeout(s.watchdog);
    clearTimeout(s.seekWatchdog);
    clearTimeout(s.restoreWatchdog);
    this.suspended = undefined;
    this.clearCue();
    this.windowCache = undefined;
    this.session = undefined;
    this.video = false;
    // Separate guards: a failing stop() (e.g. already idle) must not skip close().
    try { this.avplay.stop(); } catch { /* ignore */ }
    try { this.avplay.close(); } catch { /* ignore */ }
    this.updateSaver();
  }

  /** VOD only: live sessions are closed and reopened by the controller instead. */
  suspend(): void {
    const s = this.session;
    if (!s || s.live || !this.avplay.suspend) return;
    this.suspended = { url: s.url, positionMs: this.position(), wasPaused: this.paused() };
    try {
      this.avplay.suspend();
    } catch {
      this.suspended = undefined;
      return;
    }
    this.video = false;
    this.updateSaver();
  }

  /** True when AVPlay restored the session; false means the caller reopens it. */
  resume(): boolean {
    const sp = this.suspended;
    const s = this.session;
    this.suspended = undefined;
    if (!sp || !s || !this.avplay.restore) return false;
    try {
      this.avplay.restore(sp.url, sp.positionMs, false);
    } catch {
      return false;
    }
    this.applyDisplay();
    this.video = true;
    this.userPaused = sp.wasPaused;
    this.updateSaver();
    if (sp.wasPaused) {
      try { this.avplay.pause?.(); } catch { /* stays playing */ }
      return true;
    }
    clearTimeout(s.restoreWatchdog);
    s.restoreWatchdog = setTimeout(() => {
      this.emit(s, 'error', { code: 'NETWORK', message: MESSAGE, detail: 'restoreTimeout' });
    }, RESTORE_TIMEOUT_MS);
    return true;
  }

  /** `stop()` closes AVPlay synchronously: the previous stream is closed once `close()` has returned. */
  closed(): Promise<void> {
    return Promise.resolve();
  }

  setRect(rect: Rect | 'fullscreen'): void {
    this.rect = rect === 'fullscreen' ? FULL : { ...rect };
    if (this.session) this.applyDisplay();
    this.updateSaver();
  }

  setAspect(mode: AspectMode): void {
    this.aspect = mode;
    if (this.session) this.applyDisplay();
  }

  /** The URL in flight. Contains credentials: only for `describeStreamUrl`, never for display or logs. */
  currentUrl(): string | undefined {
    return this.session?.url;
  }

  audioTracks(): TrackInfo[] {
    if (!this.session) return [];
    let all: AvplayTrack[];
    try {
      all = this.avplay.getTotalTrackInfo();
    } catch {
      return [];
    }
    const activeIndex = this.currentTracks().find((t) => t.type === 'AUDIO')?.index;
    const out: TrackInfo[] = [];
    let n = 0;
    for (const t of all) {
      if (t.type !== 'AUDIO') continue;
      n++;
      const x = parseExtra(t);
      const language = str(x.language);
      const codec = audioCodecOf(str(x.fourCC));
      const channels = num(x.channels); // key name unverified against real firmware
      const info: TrackInfo = { id: String(t.index), label: language ?? `Track ${n}`, active: t.index === activeIndex };
      if (language) info.language = language;
      if (codec) info.codec = codec;
      if (channels) info.channels = channels;
      if (codec && TIZEN_CAPS.audio[codec]?.value === 'none') info.supported = 'no';
      out.push(info);
    }
    return out;
  }

  /** The picture plays but no listed audio track is decodable here (DTS/TrueHD only), or none is listed at all. */
  soundUndecodable(): boolean {
    const s = this.session;
    if (!s || !s.started) return false;
    const tracks = this.audioTracks();
    if (tracks.length === 0) return this.currentTracks().some((t) => t.type === 'VIDEO');
    return tracks.every((t) => t.supported === 'no');
  }

  selectAudioTrack(id: string): void {
    const idx = Number(id);
    if (!this.session || id === '' || !Number.isInteger(idx) || idx < 0) return;
    try {
      if (!this.avplay.getTotalTrackInfo().some((t) => t.type === 'AUDIO' && t.index === idx)) return;
      this.avplay.setSelectTrack('AUDIO', idx);
    } catch {
      // ignore: the current track stays
    }
  }

  streamInfo(): StreamInfo {
    const info: StreamInfo = {};
    for (const t of this.currentTracks()) {
      const x = parseExtra(t);
      if (t.type === 'VIDEO') {
        const w = num(x.Width);
        const h = num(x.Height);
        const codec = str(x.fourCC);
        const bitrate = num(x.Bit_rate);
        if (w) info.width = w;
        if (h) info.height = h;
        if (codec) info.videoCodec = codec;
        if (bitrate) info.bitrate = bitrate;
      } else if (t.type === 'AUDIO') {
        const codec = str(x.fourCC);
        if (codec) info.audioCodec = codec;
      }
    }
    return info;
  }

  /**
   * ms. Polls `getCurrentTime()` (last good value if it throws); `oncurrentplaytime` also updates the fallback
   * value, but is not relied on.
   */
  position(): number {
    if (!this.session) return this.lastPosition;
    try {
      const t = this.avplay.getCurrentTime();
      if (typeof t === 'number' && Number.isFinite(t)) this.lastPosition = t;
    } catch {
      // keep the last value
    }
    return this.lastPosition;
  }

  setLiveProfile(p: LiveProfile): void {
    this.profile = { ...p };
  }

  health(): PlaybackHealth {
    const h: PlaybackHealth = { positionMs: this.position(), engine: 'avplay' };
    const { live, window: w } = this.liveState();
    if (live !== undefined) h.isLive = live;
    if (w) {
      h.behindLiveS = Math.max(0, (w.end - h.positionMs) / 1000);
      h.behindLiveSource = 'edge';
    }
    return h;
  }

  /**
   * Seeks forward inside the live window only (rewinding live HLS on AVPlay is reported to freeze). A non-live
   * stream has no live edge: a no-op.
   */
  seekToLive(targetS: number): boolean {
    const { live, window: w } = this.liveState();
    if (live === false) return true;
    if (!w || !this.avplay.seekTo) return false;
    const to = Math.max(w.start, w.end - targetS * 1000);
    if (to <= this.position() + 250) return true;
    try {
      this.avplay.seekTo(to, () => {}, () => {});
      return true;
    } catch {
      return false;
    }
  }

  pause(): void {
    if (!this.session) return;
    try {
      this.avplay.pause?.();
    } catch {
      // ignore: keeps playing
    }
    this.userPaused = true;
    this.updateSaver();
  }

  play(): void {
    // During the pending start seek the session starts itself (no double start).
    if (!this.session || !this.session.started) return;
    try {
      this.avplay.play();
    } catch {
      // ignore: stays paused
    }
    this.userPaused = false;
    this.updateSaver();
  }

  paused(): boolean {
    if (!this.session) return false;
    try {
      return this.avplay.getState?.() === 'PAUSED';
    } catch {
      return false;
    }
  }

  /** Duration in ms of a finite stream; undefined while unknown, and for live. */
  duration(): number | undefined {
    const s = this.session;
    if (!s || !this.avplay.getDuration) return undefined;
    if (s.live && this.liveState().live === true) return undefined;
    try {
      const d = this.avplay.getDuration();
      return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : undefined;
    } catch {
      return undefined;
    }
  }

  /** Seeks to `ms` clamped to [0, duration − 1 s]; false while the duration is unknown or AVPlay cannot seek. */
  seek(ms: number): boolean {
    if (!this.session || !this.avplay.seekTo) return false;
    const to = this.clampSeek(ms);
    if (to === undefined) return false;
    try {
      this.avplay.seekTo(to, () => {}, () => {});
      this.clearCue();
      return true;
    } catch {
      return false;
    }
  }

  onSubtitle(fn: (text: string | null) => void): () => void {
    this.subtitleListeners.add(fn);
    return () => { this.subtitleListeners.delete(fn); };
  }

  textTracks(): TrackInfo[] {
    const s = this.session;
    if (!s) return [];
    let all: AvplayTrack[];
    try {
      all = this.avplay.getTotalTrackInfo();
    } catch {
      return [];
    }
    const activeIndex = s.textOff ? undefined : this.currentTracks().find((t) => t.type === 'TEXT')?.index;
    const out: TrackInfo[] = [];
    let n = 0;
    for (const t of all) {
      if (t.type !== 'TEXT') continue;
      n++;
      const language = str(parseExtra(t).language);
      const info: TrackInfo = { id: String(t.index), label: language ?? `Subtitles ${n}`, active: t.index === activeIndex };
      if (language) info.language = language;
      out.push(info);
    }
    return out;
  }

  /** Selects a TEXT track and shows subtitles; `null` hides them. */
  selectTextTrack(id: string | null): void {
    const s = this.session;
    if (!s) return;
    try {
      if (id === null) {
        // Cues are dropped whatever the firmware: without setSilentSubtitle, Off still hides every cue.
        s.textOff = true;
        this.avplay.setSilentSubtitle?.(true);
        this.clearCue();
        return;
      }
      const idx = Number(id);
      if (id === '' || !Number.isInteger(idx) || idx < 0) return;
      if (!this.avplay.getTotalTrackInfo().some((t) => t.type === 'TEXT' && t.index === idx)) return;
      this.avplay.setSelectTrack('TEXT', idx);
      this.avplay.setSilentSubtitle?.(false);
      s.textOff = false;
      this.clearCue();
    } catch {
      // ignore: the current choice stays
    }
  }

  holdLastFrame(): void {
    if (!this.avplay.setVideoStillMode) return;
    try {
      this.avplay.setVideoStillMode('true');
      this.stillOn = true;
      clearTimeout(this.holdTimer);
      this.holdTimer = setTimeout(() => this.releaseLastFrame(), HOLD_MAX_MS);
    } catch {
      // not supported here: a black frame during the reconnect, as before
    }
    this.updateSaver();
  }

  releaseLastFrame(): void {
    clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    if (!this.stillOn) {
      this.updateSaver();
      return;
    }
    this.stillOn = false;
    try {
      this.avplay.setVideoStillMode?.('false');
    } catch {
      // ignore
    }
    this.updateSaver();
  }

  onState(fn: (s: PlayerState, detail?: StateDetail) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  destroy(): void {
    this.releaseLastFrame();
    this.stop();
    this.listeners.clear();
    this.subtitleListeners.clear();
  }

  /** Shows `text` (null: nothing) and, for a positive `durationMs`, clears it when that has passed. */
  private showCue(text: string | null, durationMs: number): void {
    clearTimeout(this.cueTimer);
    this.cueTimer = undefined;
    this.emitSubtitle(text);
    if (text !== null && Number.isFinite(durationMs) && durationMs > 0) {
      this.cueTimer = setTimeout(() => {
        this.cueTimer = undefined;
        this.emitSubtitle(null);
      }, durationMs);
    }
  }

  /** Clears the cue on screen and its pending expiry. */
  private clearCue(): void {
    clearTimeout(this.cueTimer);
    this.cueTimer = undefined;
    this.emitSubtitle(null);
  }

  private emitSubtitle(text: string | null): void {
    for (const fn of [...this.subtitleListeners]) {
      try {
        fn(text);
      } catch {
        // A faulty listener must not break the player.
      }
    }
  }

  /**
   * IDLE only (after `open()`, before `prepareAsync`): the preset's buffer sizes and timeout, and the stream's
   * User-Agent when it asks for one (the only request header AVPlay can set). A failed call leaves the platform default.
   */
  private applyBuffering(userAgent?: string): void {
    const b = avplayBuffering(this.profile.preset);
    const av = this.avplay;
    const attempt = (fn: () => void) => {
      try {
        fn();
      } catch {
        // platform default stays
      }
    };
    attempt(() => av.setBufferingParam?.('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', b.play));
    attempt(() => av.setBufferingParam?.('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', b.resume));
    attempt(() => av.setTimeoutForBuffering?.(b.timeout));
    attempt(() => av.setStreamingProperty?.('ADAPTIVE_INFO', adaptiveInfo(this.panel ?? { uhd: false, eightK: false, hdrTv: false })));
    if (userAgent) attempt(() => av.setStreamingProperty?.('USER_AGENT', userAgent));
  }

  /**
   * `IS_LIVE` and, when live, `GET_LIVE_DURATION` ("start|end", ms), polled at most every 2 s. Live is false
   * when `IS_LIVE` is falsy once the stream has started (before that it is not known yet), and unknown when the
   * query fails.
   */
  private liveState(): LiveState {
    if (!this.session) return { live: undefined };
    // Opened as VOD: never live and no window; a file once started.
    if (!this.session.live) return { live: this.session.started ? false : undefined };
    if (!this.avplay.getStreamingProperty) return { live: undefined };
    const now = Date.now();
    if (this.windowCache && now - this.windowCache.at < LIVE_WINDOW_POLL_MS) return this.windowCache.value;
    let value: LiveState = { live: undefined };
    try {
      const live = String(this.avplay.getStreamingProperty('IS_LIVE')).toLowerCase();
      if (live === '1' || live === 'true') {
        value = { live: true };
        const parts = String(this.avplay.getStreamingProperty('GET_LIVE_DURATION')).split('|').map(Number);
        const start = parts[0] ?? Number.NaN;
        const end = parts[1] ?? Number.NaN;
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) value.window = { start, end };
      } else if (this.session.started) {
        value = { live: false };
      }
    } catch {
      value = { live: undefined };
    }
    // Sticky: once IS_LIVE was truthy this session stays live (an ended or windowed stream must not flip to a file).
    if (value.live === true) this.session.sawLive = true;
    else if (this.session.sawLive) value = { ...value, live: true };
    // Not cached before the stream starts: the window may appear right after `playing`.
    if (value.window !== undefined || this.session.started) this.windowCache = { at: now, value };
    return value;
  }

  /** `ms` clamped to [0, duration − 1 s]; undefined while the duration is unknown. */
  private clampSeek(ms: number): number | undefined {
    const d = this.duration();
    if (d === undefined) return undefined;
    return Math.min(Math.max(0, ms), Math.max(0, d - SEEK_END_MARGIN_MS));
  }

  private currentTracks(): AvplayTrack[] {
    if (!this.session) return [];
    try {
      return this.avplay.getCurrentStreamInfo() ?? [];
    } catch {
      return [];
    }
  }

  private sourceAspect(): number | undefined {
    const v = this.currentTracks().find((t) => t.type === 'VIDEO');
    if (!v) return undefined;
    const x = parseExtra(v);
    const w = num(x.Width);
    const h = num(x.Height);
    return w && h ? w / h : undefined;
  }

  private applyDisplay(): void {
    try {
      const d = avplayDisplay(this.rect, this.aspect, this.space, this.aspect === 'zoom' ? this.sourceAspect() : undefined);
      this.avplay.setDisplayMethod(d.method);
      this.avplay.setDisplayRect(d.x, d.y, d.w, d.h);
    } catch {
      // Not in a state that accepts it yet: it is applied again once prepared.
    }
  }

  /** Screensaver off only while a picture plays fullscreen (see `desiredScreenSaver`). */
  private updateSaver(): void {
    this.saver?.update({
      fullscreen: isFullscreen(this.rect), video: this.video || this.stillOn, paused: this.userPaused,
    });
  }

  private emit(s: Session, state: PlayerState, detail: StateDetail = {}): void {
    if (s.dead || s !== this.session) return;
    if (state === 'error' || state === 'idle') {
      this.video = false;
      this.updateSaver();
    }
    if (state === 'error') clearTimeout(s.watchdog); // one error per attempt: the prepare watchdog must not add another
    const d: StateDetail = s.attemptId === undefined ? detail : { ...detail, attemptId: s.attemptId };
    for (const fn of [...this.listeners]) {
      try {
        fn(state, d);
      } catch {
        // A faulty listener must not break the player.
      }
    }
  }
}
