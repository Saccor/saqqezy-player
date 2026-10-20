import Hls, { ErrorDetails, ErrorTypes, type ErrorData, type LevelLoadedData } from 'hls.js';
import mpegts from 'mpegts.js';
import type {
  AspectMode, EngineName, LiveProfile, OpenOptions, PlaybackHealth, Player, PlayerState, RecoverAction, Rect, StateDetail, StreamInfo,
  StreamHeaders, TrackInfo,
} from '@iptv/player';
import { hlsViaDevProxy } from '../net/devProxy.ts';
import { codecFamily } from '../vod/tracks.ts';
import { AutoMute } from './autoMute.ts';
import { chooseEngine, nextEngineAfterFailure, type TriedEngine } from './engineChoice.ts';
import { CUSHION_MAX_WAIT_MS, START_CUSHION_S, hlsConfig, mpegtsConfig } from './engineConfig.ts';
import { fpsFromSamples, noRateIsFinal, type FrameSample } from './frameRate.ts';
import { cueTextOf, nativeHlsPreferred } from './trackSupport.ts';
import type { VideoLayer } from './videoLayer.ts';

type Engine =
  | { kind: 'native' }
  | { kind: 'hls'; hls: Hls }
  | { kind: 'mpegts'; player: mpegts.Player };

/** One `open()`; once `dead`, nothing it registered may emit again. */
interface Session {
  /** The URL as given to `open()` (before any dev-proxy wrapping). */
  url: string;
  /** The play's User-Agent and Referer (`OpenOptions.headers`): carried by the dev proxy route, dropped elsewhere. */
  headers?: StreamHeaders;
  attemptId: number | undefined;
  /** False for a file/VOD (`open(…, { live: false })`): nothing live-only runs, and it never reports live. */
  live: boolean;
  /** VOD start position in ms; for the element engines, applied on the first `loadedmetadata`. */
  startMs?: number;
  dead: boolean;
  engine: Engine | undefined;
  /** Engine to switch to if the element fails before metadata (extensionless URLs only). */
  fallback?: 'mpegts';
  /** True when the URL path has no file extension. */
  extensionless: boolean;
  /** Engines started so far in this session, in order. */
  tried: TriedEngine[];
  cleanups: (() => void)[];
  /** Clock ms of the last network byte (mpegts.js statistics); undefined until the first. */
  lastByteAt?: number;
  /** HLS target duration in seconds, from the first live LEVEL_LOADED. */
  targetDurationS?: number;
  /** hls.js: the playlist's `live` flag from the latest LEVEL_LOADED; undefined until then. */
  hlsLive?: boolean;
  /** Latch: this session has seen live (hls.js `live`, native Infinity). Once set it stays live (ENDLIST must not demote it). */
  sawLive?: boolean;
  /** EOS has been reported for this session (once only). */
  eosSent?: boolean;
  /** Fatal hls.js media errors recovered in place so far (Task 9). */
  mediaRecoveries: number;
  /** Clock ms of the last in-place hls.js network recovery (Task 9). */
  lastNetRecoveryAt: number;
  /** mpegts.js: the browser refused the audio codec (e.g. Dolby in desktop Chrome); the video plays on, silent. */
  audioUnsupported?: boolean;
}

const HLS_MIME = 'application/vnd.apple.mpegurl';
const TS_MIME = 'video/mp2t';
const HLS_CODEC_ERRORS = new Set<string>([
  ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR,
  ErrorDetails.BUFFER_ADD_CODEC_ERROR,
  ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR,
]);

/**
 * Refusals (core's REFUSAL_STATUSES): reported as AUTH, so the supervisor stops and the cooldown starts. 410 is not
 * one: an expired stream (e.g. a catch-up programme past the archive) says nothing about the source refusing us, so
 * it is reported as NETWORK with its status and takes the supervisor's "gone" path, with no cooldown on the host.
 */
const AUTH_STATUSES = new Set([401, 403, 429, 458, 503, 509]);
/**
 * hls.js manifest or media-playlist loads answered with a status that will not change on an in-place reload (bad
 * request, not there, gone, server error): reported at once as NETWORK with the status, so the supervisor decides
 * (a missing catch-up programme ends as Not available in seconds instead of after the in-place reloads).
 */
const HLS_PLAYLIST_LOAD_ERRORS = new Set<string>([ErrorDetails.MANIFEST_LOAD_ERROR, ErrorDetails.LEVEL_LOAD_ERROR]);
const finalLoadStatus = (st: number): boolean => st === 400 || st === 404 || st === 410 || (st >= 500 && st < 600);
/** mpegts.js network error detail for a non-2xx HTTP status (its `info.code` holds the status). */
const MPEGTS_HTTP_STATUS = 'HttpStatusCodeInvalid';

/** An MSE error from mpegts.js that only concerns the audio SourceBuffer (`addSourceBuffer('audio/mp4;…')`). */
function isAudioMseError(detail: string, info: { msg?: unknown } | undefined): boolean {
  return detail === mpegts.ErrorDetails.MEDIA_MSE_ERROR && typeof info?.msg === 'string' && /['"(]audio\//.test(info.msg);
}
const EOS_MESSAGE = 'Stream ended';
/** Diagnostics names for each engine and for `<video>` MediaError codes (journal `detail`; never a URL). */
const ENGINE_NAMES = { native: 'native', hls: 'hls.js', mpegts: 'mpegts.js' } as const satisfies Record<string, EngineName>;
const MEDIA_ERROR_NAMES: Record<number, string> = {
  1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
};
/** A wall clock (EXT-X-PROGRAM-DATE-TIME) outside this range is a broken stamp, not a delay. */
const PDT_MIN_S = -5;
const PDT_MAX_S = 600;
/** mpegts.js after LOADING_COMPLETE: EOS once less than this is buffered ahead (the download ends before playback). */
const DRAINED_S = 0.5;
const DRAIN_POLL_MS = 250;
/** A second fatal network error within this window is reported instead of recovered in place. */
const HLS_NET_RECOVERY_GAP_MS = 10_000;
/** A held frame never outlives this, even if no stream comes back. */
const HOLD_MAX_MS = 30_000;

interface NativeAudioTrack { id: string; label: string; language: string; enabled: boolean }
interface NativeAudioTrackList { length: number; [i: number]: NativeAudioTrack }
interface NativeTextTrack { kind: string; label: string; language: string; mode: string; activeCues?: ArrayLike<{ text?: string }> | null }
/** How often the selected subtitle track's active cues are read (cuechange is unreliable on older TV engines). */
const SUBTITLE_POLL_MS = 250;
/** Seconds of played picture with no decoded audio before the sound counts as undecodable (`soundUndecodable`). */
const SILENT_AFTER_S = 3;
interface NativeTextTrackList { length: number; [i: number]: NativeTextTrack }
const isSubtitleKind = (t: NativeTextTrack | undefined): t is NativeTextTrack => t?.kind === 'subtitles' || t?.kind === 'captions';
/** A VOD seek never lands closer than this to the end (that would end the film at once). */
const SEEK_END_MARGIN_S = 1;
/** How long frame callbacks are sampled to measure the frame rate. */
const FPS_SAMPLE_MS = 1000;
/** How many measured frame rates are kept (per opened URL). */
const MEASURED_FPS_MAX = 20;
/** hls.js back buffer for VOD (s): short rewinds stay in the buffer. */
const VOD_BACK_BUFFER_S = 60;
/** hls.js options that only steer a live stream; a VOD session leaves them at the library defaults. */
const HLS_LIVE_SYNC_KEYS = ['liveSyncMode', 'liveSyncDurationCount', 'liveMaxLatencyDurationCount', 'maxLiveSyncPlaybackRate'] as const;

/** `navigator.userActivation` where the engine has it (Chromium 72+). */
function userActivation(): { isActive: boolean; hasBeenActive: boolean } | undefined {
  return (navigator as Navigator & { userActivation?: { isActive: boolean; hasBeenActive: boolean } }).userActivation;
}

function pathOf(url: string): string {
  try {
    return new URL(url, location.href).pathname.toLowerCase();
  } catch {
    return url.toLowerCase().split(/[?#]/)[0] ?? '';
  }
}

/**
 * `Player` on an HTML5 `<video>`: native HLS where the platform has it, else hls.js for `.m3u8`;
 * mpegts.js (live) for `.ts` and for extensionless URLs the element cannot play; any other extension is handed
 * to the element directly (see `chooseEngine`).
 */
export class Html5Player implements Player {
  private readonly video: HTMLVideoElement;
  private readonly listeners = new Set<(s: PlayerState, d?: StateDetail) => void>();
  private session: Session | undefined;
  private frameOverlay: { remove(): void } | undefined;
  private overlayTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly subtitleListeners = new Set<(text: string | null) => void>();
  private subtitleTimer: ReturnType<typeof setInterval> | undefined;
  /** The cue text last reported (null: none shown). */
  private lastCue: string | null = null;
  private readonly preferNativeHls: boolean;
  private readonly isTv: boolean;
  private readonly autoMute: AutoMute;
  private profile: LiveProfile = { preset: 'balanced', targetS: 3, allowRate: false };
  /** Frame rates measured from presented frames, per opened URL (oldest first); null: no clear rate. */
  private readonly measuredFps = new Map<string, number | null>();
  /** The frame-rate measurement in progress. */
  private fpsSampling: { cancel: () => void } | undefined;

  constructor(private readonly layer: VideoLayer, opts: { preferNativeHls?: boolean; isTv?: boolean } = {}) {
    this.video = layer.video;
    this.preferNativeHls = opts.preferNativeHls ?? true;
    this.isTv = opts.isTv ?? false;
    this.autoMute = new AutoMute(this.video);
  }

  /**
   * The picture plays but the browser decodes no sound: mpegts.js was refused the audio codec, or (computers only)
   * the element decoded no audio bytes during SILENT_AFTER_S of played picture. Desktop Chrome plays files with
   * AC-3 / E-AC-3 sound that way, silently and with no error. TVs skip the counters: hardware decoders may not
   * count.
   */
  soundUndecodable(): boolean {
    const s = this.session;
    if (!s || s.dead) return false;
    if (s.audioUnsupported) return true;
    if (this.isTv) return false;
    const v = this.video as HTMLVideoElement & { webkitAudioDecodedByteCount?: number; webkitVideoDecodedByteCount?: number };
    if (v.webkitAudioDecodedByteCount !== 0 || !v.webkitVideoDecodedByteCount) return false;
    const played = v.played;
    let playedS = 0;
    for (let i = 0; i < (played?.length ?? 0); i++) playedS += played.end(i) - played.start(i);
    return playedS >= SILENT_AFTER_S;
  }

  /**
   * Gives the sound back after an autoplay-policy mute; call it from a keydown. Only a key that really
   * activated the page counts (see `AutoMute.releaseOnGesture`).
   */
  unmuteIfAutoMuted(): void {
    this.autoMute.releaseOnGesture(userActivation());
  }

  /** The app's volume, 0..1 (the user's mute arrives as 0, so it never touches the autoplay mute). */
  setVolume(level: number): void {
    this.video.volume = Math.max(0, Math.min(1, level));
  }

  open(url: string, attemptId?: number, opts: OpenOptions = {}): Promise<void> {
    this.stop();
    // Once the page has had a user gesture, playback with sound is allowed again.
    this.autoMute.releaseIfActivated(userActivation());
    const path = pathOf(url);
    const s: Session = { url, attemptId, live: opts.live !== false, dead: false, engine: undefined, extensionless: !path.slice(path.lastIndexOf('/') + 1).includes('.'), tried: [], cleanups: [], mediaRecoveries: 0, lastNetRecoveryAt: Number.NEGATIVE_INFINITY };
    if (!s.live && opts.startMs !== undefined && opts.startMs > 0) s.startMs = opts.startMs;
    if (opts.headers) s.headers = opts.headers;
    this.session = s;
    const v = this.video;
    v.playbackRate = 1;
    const src = hlsViaDevProxy(url, s.headers);

    const on = <K extends keyof HTMLMediaElementEventMap>(type: K, fn: () => void) => {
      v.addEventListener(type, fn);
      s.cleanups.push(() => v.removeEventListener(type, fn));
    };
    on('playing', () => {
      void this.liveOf(s);
      this.releaseLastFrame();
      this.emit(s, 'playing');
    });
    on('waiting', () => this.emit(s, 'buffering'));
    // VOD resume on the element engines (hls.js takes its own `startPosition`): once, when seeking becomes possible.
    // Consumed only once the seek lands: the duration may still be unknown (NaN/Infinity), so it is retried on
    // `durationchange` too.
    const applyStart = () => {
      const ms = s.startMs;
      if (ms === undefined || s.engine?.kind === 'hls') return;
      if (this.seekTo(ms)) s.startMs = undefined;
    };
    on('loadedmetadata', applyStart);
    // Observe liveness while the stream plays so the latch is set before the server can end it.
    on('durationchange', () => {
      applyStart();
      void this.liveOf(s);
    });
    // A live stream that ends has been closed by the server: reconnect at once (the supervisor maps EOS).
    // A file (or a stream not known to be live) simply ended: 'idle', which never reconnects.
    on('ended', () => {
      if (this.liveOf(s) === true) this.emitEos(s);
      else this.emit(s, 'idle');
    });
    on('error', () => {
      const err = v.error;
      // With MSE engines the engine reports errors itself; MediaError 4 is still decisive.
      if (!err) return;
      if (this.tryFallback(s)) return;
      // MediaError 4 (SRC_NOT_SUPPORTED) before any metadata (HAVE_NOTHING) is a failed load (404, refused,
      // dropped connection), so it is retryable NETWORK; only once metadata has loaded is it really UNSUPPORTED.
      const code = err.code === 4
        ? (v.readyState === 0 ? 'NETWORK' : 'UNSUPPORTED')
        : err.code === 2 ? 'NETWORK' : err.code === 3 ? 'DECODE' : 'MEDIA';
      this.emit(s, 'error', { code, message: 'Playback error', detail: MEDIA_ERROR_NAMES[err.code] });
    });

    this.emit(s, 'loading');

    const choice = chooseEngine(path, {
      nativeHls: v.canPlayType(HLS_MIME) !== '',
      nativeTs: v.canPlayType(TS_MIME) !== '',
      hlsJs: Hls.isSupported(),
      mpegtsJs: mpegts.isSupported(),
      preferNativeHls: nativeHlsPreferred({ prefer: this.preferNativeHls, live: s.live, audioTrackApi: 'audioTracks' in v }),
    });
    if (choice.engine === 'none') {
      const message = choice.reason === 'hls' ? 'HLS is not supported here' : 'MPEG-TS is not supported here';
      this.emit(s, 'error', { code: 'UNSUPPORTED', message, detail: 'noEngine' });
      return Promise.resolve();
    }
    if (choice.engine === 'native' && choice.fallback) s.fallback = choice.fallback;
    this.startEngine(s, choice.engine, src);
    if (choice.engine === 'mpegts') this.playAfterCushion(s);
    else this.playSession(s);
    return Promise.resolve();
  }

  private startEngine(s: Session, kind: 'native' | 'hls' | 'mpegts', src: string): void {
    const v = this.video;
    s.tried.push(kind);
    if (kind === 'native') {
      s.engine = { kind: 'native' };
      v.src = src;
    } else if (kind === 'hls') {
      const hls = new Hls(s.live ? hlsConfig(this.profile.preset, this.isTv) : this.vodHlsConfig(s));
      // VOD: the selected subtitle track loads its cues into a hidden text track; the app draws them (onSubtitle).
      if (!s.live) hls.subtitleDisplay = false;
      s.engine = { kind: 'hls', hls };
      hls.on(Hls.Events.LEVEL_LOADED, (_e, data: LevelLoadedData) => {
        s.hlsLive = data.details.live;
        if (data.details.live) s.sawLive = true;
        if (data.details.live && s.targetDurationS === undefined) s.targetDurationS = data.details.targetduration;
      });
      hls.on(Hls.Events.ERROR, (_e, data: ErrorData) => {
        // Non-fatal codec errors (e.g. one unplayable level) are recoverable: only fatal ones, or a manifest
        // with no playable codec at all, are reported.
        if (!data.fatal && data.details !== ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR) return;
        // After mpegts.js rejected the stream, a manifest that hls.js cannot parse means neither engine fits.
        if (HLS_CODEC_ERRORS.has(data.details)
          || (s.tried.includes('mpegts') && data.details === ErrorDetails.MANIFEST_PARSING_ERROR)) {
          this.emit(s, 'error', { code: 'UNSUPPORTED', message: 'Playback error', detail: data.details });
          return;
        }
        const network = data.type === ErrorTypes.NETWORK_ERROR;
        const status = data.response?.code;
        if (network && status !== undefined && AUTH_STATUSES.has(status)) {
          this.emit(s, 'error', { code: 'AUTH', message: 'Playback error', httpStatus: status, detail: data.details });
          return;
        }
        if (network && status !== undefined && HLS_PLAYLIST_LOAD_ERRORS.has(data.details) && finalLoadStatus(status)) {
          this.emit(s, 'error', { code: 'NETWORK', message: 'Playback error', httpStatus: status, detail: data.details });
          return;
        }
        if (this.recoverHls(s, hls, network ? 'network' : 'media')) return;
        const known = network && status !== undefined && status > 0 ? { httpStatus: status } : {};
        this.emit(s, 'error', { code: network ? 'NETWORK' : 'MEDIA', message: 'Playback error', ...known, detail: data.details });
      });
      hls.loadSource(src);
      hls.attachMedia(v);
    } else {
      const config = mpegtsConfig(this.profile.preset, this.isTv);
      // A file: no live sync or latency chasing, and lazy loading so a long film is not pulled into memory at once.
      const vod = { isLive: false, liveSync: false, liveBufferLatencyChasing: false, lazyLoad: true };
      const player = mpegts.createPlayer({ type: 'mpegts', isLive: s.live, url: src }, s.live ? config : { ...config, ...vod });
      s.engine = { kind: 'mpegts', player };
      const current = () => !s.dead && s.engine?.kind === 'mpegts' && s.engine.player === player;
      player.on(mpegts.Events.ERROR, (type: string, detail: string, info?: { code?: number; msg?: unknown }) => {
        // Nothing from a torn-down instance (stale session or already swapped for the HLS retry) may surface.
        if (!current()) return;
        // The browser cannot decode the audio (desktop Chrome has no AC-3/E-AC-3, common on UHD channels).
        // mpegts.js keeps feeding the video SourceBuffer, so the picture plays on without sound; failing here
        // would only reconnect into the same error, forever black.
        if (isAudioMseError(detail, info)) {
          s.audioUnsupported = true;
          return;
        }
        if (detail === MPEGTS_HTTP_STATUS && info?.code !== undefined && AUTH_STATUSES.has(info.code)) {
          this.emit(s, 'error', { code: 'AUTH', message: 'Playback error', httpStatus: info.code, detail });
          return;
        }
        if (detail === MPEGTS_HTTP_STATUS && typeof info?.code === 'number' && info.code > 0) {
          // Any other HTTP status (404, 410, 5xx): a plain network error that carries the status for the supervisor.
          this.emit(s, 'error', { code: 'NETWORK', message: 'Playback error', httpStatus: info.code, detail });
          return;
        }
        const formatError = detail === mpegts.ErrorDetails.MEDIA_FORMAT_ERROR
          || detail === mpegts.ErrorDetails.MEDIA_FORMAT_UNSUPPORTED;
        if (formatError && this.video.readyState === 0 && this.retryAsHls(s)) return;
        const unsupported = detail === mpegts.ErrorDetails.MEDIA_CODEC_UNSUPPORTED
          || detail === mpegts.ErrorDetails.MEDIA_FORMAT_UNSUPPORTED;
        const code = unsupported ? 'UNSUPPORTED' : type === mpegts.ErrorTypes.NETWORK_ERROR ? 'NETWORK' : 'MEDIA';
        this.emit(s, 'error', { code, message: 'Playback error', detail });
      });
      // A clean end of the HTTP body: the download is over, but playback may still have a long way to go (a file,
      // or a server that bursts then closes). Report EOS (reconnect) only once the buffer ahead has drained; the
      // element's own `ended` also covers the end.
      // VOD: the download ending is not the end of the film; the element's `ended` reports that ('idle').
      player.on(mpegts.Events.LOADING_COMPLETE, () => {
        if (current() && s.live) this.eosWhenDrained(s, current);
      });
      player.on(mpegts.Events.STATISTICS_INFO, (stats: { speed?: number }) => {
        if (current() && (stats.speed ?? 0) > 0) s.lastByteAt = Date.now();
      });
      player.attachMediaElement(v);
      player.load();
    }
  }

  /** hls.js for a VOD session: the shared config without the live-sync tuning, plus the start position. */
  private vodHlsConfig(s: Session): ReturnType<typeof hlsConfig> {
    const config: ReturnType<typeof hlsConfig> = { ...hlsConfig(this.profile.preset, this.isTv), lowLatencyMode: false };
    for (const k of HLS_LIVE_SYNC_KEYS) delete config[k];
    if (s.startMs !== undefined) config.startPosition = s.startMs / 1000;
    config.backBufferLength = VOD_BACK_BUFFER_S; // short rewinds must not refetch
    return config;
  }

  /** In-place recovery for a fatal hls.js error; keeps the element and its last frame. False: report the error. */
  private recoverHls(s: Session, hls: Hls, kind: 'network' | 'media'): boolean {
    if (kind === 'network') {
      const now = Date.now();
      if (now - s.lastNetRecoveryAt < HLS_NET_RECOVERY_GAP_MS) return false;
      s.lastNetRecoveryAt = now;
      // No synthetic 'buffering': if hls.js reloads before the element runs dry, no 'playing' would follow it.
      // The element's own waiting/playing events report the state.
      hls.startLoad(-1);
      return true;
    }
    s.mediaRecoveries++;
    if (s.mediaRecoveries === 1) {
      hls.recoverMediaError();
      return true;
    }
    if (s.mediaRecoveries === 2) {
      hls.swapAudioCodec();
      hls.recoverMediaError();
      return true;
    }
    return false;
  }

  recover(action: RecoverAction): boolean {
    const s = this.session;
    if (!s) return false;
    if (action === 'softReload') {
      if (s.engine?.kind !== 'hls') return false;
      s.engine.hls.startLoad(-1);
      return true;
    }
    const v = this.video;
    const b = v.buffered;
    if (!b || b.length === 0) return false;
    const t = v.currentTime;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= t + 0.05 && t < b.end(i) - 0.1) {
        v.currentTime = t + 0.1; // stuck inside buffered data: nudge
        return true;
      }
    }
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) > t) {
        v.currentTime = b.start(i) + 0.05; // at a range end or before the data: jump the gap
        return true;
      }
    }
    return false;
  }

  seekToLive(targetS: number): boolean {
    const s = this.session;
    const v = this.video;
    const e = s?.engine;
    if (!s || !e) return false;
    this.stopFpsSampling();
    // No live edge: seeking "to live" would jump to the end of a file.
    if (!s.live || this.liveOf(s) === false) return true;
    if (e.kind === 'hls') {
      const pos = e.hls.liveSyncPosition;
      if (pos === null || !Number.isFinite(pos)) return false;
      v.currentTime = pos;
      return true;
    }
    const r = e.kind === 'native' ? v.seekable : v.buffered;
    if (!r || r.length === 0) return false;
    const end = r.end(r.length - 1);
    if (!Number.isFinite(end)) return false;
    const to = Math.max(r.start(r.length - 1), end - targetS); // never into a gap before the last range
    if (to > v.currentTime + 0.25) v.currentTime = to;
    return true;
  }

  pause(): void {
    if (this.session) this.video.pause();
  }

  /** Resumes the element; an autoplay refusal is handled like at open (auto-mute), other rejections are ignored. */
  play(): void {
    const s = this.session;
    if (s) this.playSession(s);
  }

  paused(): boolean {
    return this.session ? this.video.paused : false;
  }

  /** Duration in ms of a finite stream; undefined while unknown, and for live (Infinity). */
  duration(): number | undefined {
    const d = this.video.duration;
    return this.session && Number.isFinite(d) && d > 0 ? d * 1000 : undefined;
  }

  seek(ms: number): boolean {
    if (!this.session) return false;
    return this.seekTo(ms);
  }

  /** Sets the playhead clamped to [0, duration − 1 s]; false while the duration is not finite. */
  private seekTo(ms: number): boolean {
    this.stopFpsSampling();
    const d = this.video.duration;
    if (!Number.isFinite(d) || d <= 0) return false;
    this.video.currentTime = Math.min(Math.max(0, ms / 1000), Math.max(0, d - SEEK_END_MARGIN_S));
    return true;
  }

  textTracks(): TrackInfo[] {
    const e = this.session?.engine;
    if (e?.kind === 'hls') {
      const active = e.hls.subtitleTrack;
      return e.hls.subtitleTracks.map((t, i) => {
        const info: TrackInfo = { id: String(i), label: t.name || t.lang || `Subtitles ${i + 1}`, active: i === active };
        if (t.lang) info.language = t.lang;
        return info;
      });
    }
    const list = (this.video as HTMLVideoElement & { textTracks?: NativeTextTrackList }).textTracks;
    if (!list) return [];
    const out: TrackInfo[] = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!isSubtitleKind(t)) continue;
      const info: TrackInfo = { id: String(i), label: t.label || t.language || `Subtitles ${out.length + 1}`, active: t.mode !== 'disabled' };
      if (t.language) info.language = t.language;
      out.push(info);
    }
    return out;
  }

  selectTextTrack(id: string | null): void {
    if (id === '') return;
    const idx = id === null ? -1 : Number(id);
    if (!Number.isInteger(idx) || idx < -1) return;
    const e = this.session?.engine;
    if (e?.kind === 'hls') {
      if (idx < e.hls.subtitleTracks.length) e.hls.subtitleTrack = idx;
      return;
    }
    const list = (this.video as HTMLVideoElement & { textTracks?: NativeTextTrackList }).textTracks;
    if (!list || idx >= list.length) return;
    if (idx >= 0 && !isSubtitleKind(list[idx])) return;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      // Hidden, not showing: the cues still load, and the app draws them (onSubtitle) clear of its overlay.
      if (isSubtitleKind(t)) t.mode = i === idx ? 'hidden' : 'disabled';
    }
  }

  /**
   * The selected subtitle track's cue text (native tracks and hls.js, which loads its cues into a hidden text track),
   * read every SUBTITLE_POLL_MS while someone listens; changes only, `null` when the cue clears. A track the element
   * shows by itself (a default track) is switched to hidden, so the cue is never drawn twice.
   */
  onSubtitle(fn: (text: string | null) => void): () => void {
    this.subtitleListeners.add(fn);
    if (this.subtitleTimer === undefined) this.subtitleTimer = setInterval(() => this.pollSubtitle(), SUBTITLE_POLL_MS);
    return () => {
      this.subtitleListeners.delete(fn);
      if (this.subtitleListeners.size === 0 && this.subtitleTimer !== undefined) {
        clearInterval(this.subtitleTimer);
        this.subtitleTimer = undefined;
      }
    };
  }

  private pollSubtitle(): void {
    const list = (this.video as HTMLVideoElement & { textTracks?: NativeTextTrackList }).textTracks;
    let text: string | null = null;
    const e = this.session?.engine;
    if (e?.kind === 'hls') {
      // Only hls.js's selected subtitle track: the captions track it adds for embedded CEA-608 is never listed or
      // chosen, so it must never show.
      const chosen = e.hls.subtitleTrack >= 0 ? e.hls.subtitleTracks[e.hls.subtitleTrack] : undefined;
      if (chosen && list) {
        for (let i = 0; i < list.length; i++) {
          const t = list[i];
          if (t?.kind !== 'subtitles' || t.mode === 'disabled' || t.label !== chosen.name) continue;
          text = cueTextOf(t.activeCues);
          break;
        }
      }
    } else if (this.session && list) {
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if (!isSubtitleKind(t) || t.mode === 'disabled') continue;
        if (t.mode === 'showing') t.mode = 'hidden';
        text = cueTextOf(t.activeCues);
        break;
      }
    }
    this.emitSubtitle(text);
  }

  private emitSubtitle(text: string | null): void {
    if (text === this.lastCue) return;
    this.lastCue = text;
    for (const fn of [...this.subtitleListeners]) {
      try {
        fn(text);
      } catch {
        // A faulty listener must not break the player.
      }
    }
  }

  holdLastFrame(): void {
    if (this.frameOverlay || typeof document === 'undefined') return;
    const v = this.video;
    const box = v.parentElement;
    if (!box || !v.videoWidth || !v.videoHeight) return;
    try {
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.className = 'video-hold';
      Object.assign(c.style, {
        position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', objectFit: v.style.objectFit || 'contain',
      });
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, c.width, c.height);
      box.appendChild(c);
      this.frameOverlay = c;
      this.overlayTimer = setTimeout(() => this.releaseLastFrame(), HOLD_MAX_MS);
    } catch {
      // A frame we cannot draw: the spinner over black, as before.
    }
  }

  releaseLastFrame(): void {
    if (this.overlayTimer !== undefined) clearTimeout(this.overlayTimer);
    this.overlayTimer = undefined;
    this.frameOverlay?.remove();
    this.frameOverlay = undefined;
  }

  /**
   * The element failed before any metadata on a stream it only might play (extensionless URL): switch this
   * session to the fallback engine instead of reporting the error. Returns true when it did.
   */
  private tryFallback(s: Session): boolean {
    const next = s.fallback;
    if (!next || s.engine?.kind !== 'native' || this.video.readyState !== 0) return false;
    s.fallback = undefined;
    const v = this.video;
    v.removeAttribute('src');
    v.load();
    this.startEngine(s, next, hlsViaDevProxy(s.url, s.headers));
    this.playSession(s);
    return true;
  }

  /**
   * mpegts.js rejected an extensionless URL as non-MPEG-TS before metadata: retry the same URL once as HLS.
   * Called from mpegts.js's ERROR callback, so the instance is only detached from the session here (its further
   * errors are ignored); the teardown and the engine switch run after the callback has returned
   * (`setTimeout(0)`), never inside mpegts.js's own call stack. A `stop()` in between still gets the old
   * instance torn down, and nothing new is started for a dead session.
   */
  private retryAsHls(s: Session): boolean {
    const next = nextEngineAfterFailure(s.extensionless ? '' : '.', s.tried, 'format', {
      nativeHls: this.video.canPlayType(HLS_MIME) !== '',
      hlsJs: Hls.isSupported(),
    });
    if (!next) return false;
    const old = s.engine;
    s.engine = undefined;
    setTimeout(() => {
      this.teardownEngine(old);
      if (s.dead || s !== this.session) return;
      const v = this.video;
      v.removeAttribute('src');
      v.load();
      this.startEngine(s, next, hlsViaDevProxy(s.url, s.headers));
      this.playSession(s);
    }, 0);
    return true;
  }

  private teardownEngine(e: Engine | undefined): void {
    if (e?.kind === 'hls') {
      e.hls.detachMedia();
      e.hls.destroy();
    } else if (e?.kind === 'mpegts') {
      // Each call is guarded on its own so one failure cannot skip the rest.
      for (const step of [
        () => e.player.pause(),
        () => e.player.unload(),
        () => e.player.detachMediaElement(),
        () => e.player.destroy(),
      ]) {
        try {
          step();
        } catch {
          // ignore
        }
      }
    }
  }

  private playSession(s: Session): void {
    this.video.play().catch((err: unknown) => {
      if (s.dead) return;
      // Desktop autoplay policy: without a user gesture only muted playback may start.
      // The mute is remembered and dropped on the next key press (`unmuteIfAutoMuted`).
      if (err instanceof DOMException && err.name === 'NotAllowedError' && this.autoMute.mute()) {
        this.playSession(s);
      }
      // AbortError (superseded by stop/open) and the rest surface through the element/engine error events.
    });
  }

  stop(): void {
    this.stopFpsSampling();
    const s = this.session;
    if (!s) return;
    s.dead = true;
    this.session = undefined;
    this.emitSubtitle(null);
    for (const c of s.cleanups) c();
    this.teardownEngine(s.engine);
    const v = this.video;
    v.pause();
    v.removeAttribute('src');
    v.load();
  }

  /**
   * Resolves once the last `stop()`'s teardown has run (hls.js `destroy()`; mpegts.js `unload()`,
   * `detachMediaElement()`, `destroy()`; the element's `removeAttribute('src')` + `load()`, all synchronous in
   * `stop()`), plus one macrotask so the browser drops the request (and a deferred mpegts.js teardown, queued earlier,
   * has run). The supervisor awaits it before the next open or the status probe.
   */
  closed(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /**
   * True when the current attempt's engine reports HTTP statuses itself (hls.js, mpegts.js: a refusal arrives as
   * AUTH with `httpStatus`). The native element cannot see them, so the supervisor may ask with its status probe.
   */
  supportsStatus(): boolean {
    const kind = this.session?.engine?.kind;
    return kind === 'hls' || kind === 'mpegts';
  }

  setRect(rect: Rect | 'fullscreen'): void {
    this.layer.setRect(rect);
  }

  setAspect(mode: AspectMode): void {
    this.layer.setAspect(mode);
  }

  /**
   * The URL of the stream in flight (the supervisor may have switched to the alternate format). Contains
   * credentials: only for `describeStreamUrl`, never for display or logs.
   */
  currentUrl(): string | undefined {
    return this.session?.url;
  }

  audioTracks(): TrackInfo[] {
    const e = this.session?.engine;
    if (e?.kind === 'hls') {
      const active = e.hls.audioTrack;
      return e.hls.audioTracks.map((t, i) => {
        const info: TrackInfo = { id: String(i), label: t.name || t.lang || `Track ${i + 1}`, active: i === active };
        if (t.lang) info.language = t.lang;
        const codec = codecFamily(t.audioCodec);
        if (codec) info.codec = codec;
        return info;
      });
    }
    const list = (this.video as HTMLVideoElement & { audioTracks?: NativeAudioTrackList }).audioTracks;
    if (!list) return [];
    const out: TrackInfo[] = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!t) continue;
      const info: TrackInfo = { id: String(i), label: t.label || t.language || `Track ${i + 1}`, active: t.enabled };
      if (t.language) info.language = t.language;
      out.push(info);
    }
    return out;
  }

  selectAudioTrack(id: string): void {
    const idx = Number(id);
    if (!Number.isInteger(idx) || idx < 0) return;
    const e = this.session?.engine;
    if (e?.kind === 'hls') {
      if (idx < e.hls.audioTracks.length) e.hls.audioTrack = idx;
      return;
    }
    const list = (this.video as HTMLVideoElement & { audioTracks?: NativeAudioTrackList }).audioTracks;
    if (!list || idx >= list.length) return;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (t) t.enabled = i === idx;
    }
  }

  streamInfo(): StreamInfo {
    const v = this.video;
    const info: StreamInfo = {};
    if (v.videoWidth) info.width = v.videoWidth;
    if (v.videoHeight) info.height = v.videoHeight;
    const e = this.session?.engine;
    if (e?.kind === 'hls') {
      const level = e.hls.levels[e.hls.currentLevel];
      if (level) {
        if (level.videoCodec) info.videoCodec = level.videoCodec;
        if (level.audioCodec) info.audioCodec = level.audioCodec;
        if (level.bitrate) info.bitrate = level.bitrate;
        if (level.frameRate) info.fps = level.frameRate;
      }
    } else if (e?.kind === 'mpegts') {
      const mi = e.player.mediaInfo as { videoCodec?: string; audioCodec?: string; fps?: number } | undefined;
      if (mi?.videoCodec) info.videoCodec = mi.videoCodec;
      if (mi?.audioCodec) info.audioCodec = this.session?.audioUnsupported ? `${mi.audioCodec} (not supported here)` : mi.audioCodec;
      if (mi?.fps) info.fps = mi.fps;
    }
    // The engine has no rate (a plain file, or a playlist without one): the rate measured from presented frames.
    if (info.fps === undefined) {
      const url = this.session?.url;
      const measured = url === undefined ? undefined : this.measuredFps.get(url);
      // null: measured once without a clear rate; not tried again for this file this session.
      if (measured === undefined) this.measureFps();
      else if (measured !== null) info.fps = measured;
    }
    return info;
  }

  /**
   * Starts measuring the playing video's frame rate (about FPS_SAMPLE_MS of frame callbacks while it plays at
   * normal speed); the result is kept per opened URL. Nothing where the browser has no video frame callback.
   */
  private measureFps(): void {
    const v = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number; presentedFrames: number }) => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    const s = this.session;
    const request = v.requestVideoFrameCallback;
    if (!s || this.fpsSampling || typeof request !== 'function' || v.paused || v.playbackRate !== 1) return;
    const samples: FrameSample[] = [];
    let handle = 0;
    let startedAt: number | undefined;
    const sampling = { cancel: () => v.cancelVideoFrameCallback?.(handle) };
    const step = (now: number, meta: { mediaTime: number; presentedFrames: number }) => {
      if (this.fpsSampling !== sampling || s !== this.session) return;
      if (v.playbackRate !== 1) {
        this.fpsSampling = undefined; // asked again later
        return;
      }
      samples.push({ mediaTime: meta.mediaTime, presentedFrames: meta.presentedFrames });
      startedAt ??= now;
      if (now - startedAt < FPS_SAMPLE_MS) {
        handle = request.call(v, step);
        return;
      }
      this.fpsSampling = undefined;
      // No clear rate is kept too (null), so polling does not measure the same file again and again; but only
      // after a full window: callbacks stop while paused or hidden, and a short window is measured again.
      const fps = fpsFromSamples(samples);
      if (fps === undefined && !noRateIsFinal(samples.length)) return;
      this.measuredFps.set(s.url, fps ?? null);
      if (this.measuredFps.size > MEASURED_FPS_MAX) {
        const oldest = this.measuredFps.keys().next().value;
        if (oldest !== undefined) this.measuredFps.delete(oldest);
      }
    };
    this.fpsSampling = sampling;
    handle = request.call(v, step);
  }

  private stopFpsSampling(): void {
    this.fpsSampling?.cancel();
    this.fpsSampling = undefined;
  }

  position(): number {
    return this.video.currentTime * 1000;
  }

  setLiveProfile(p: LiveProfile): void {
    this.profile = { ...p };
  }

  setPlaybackRate(rate: number): void {
    if (this.session) this.video.playbackRate = rate;
  }

  health(): PlaybackHealth {
    const v = this.video;
    const s = this.session;
    const h: PlaybackHealth = { positionMs: v.currentTime * 1000 };
    if (v.buffered) {
      h.bufferAheadS = this.bufferAhead();
      h.rangeCount = v.buffered.length;
    }
    const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : undefined;
    // Engines that never count frames report 0: leave it out so frozen-video detection stays off there.
    if (q && q.totalVideoFrames > 0) h.framesPresented = q.totalVideoFrames - q.droppedVideoFrames;
    const e = s?.engine;
    if (e) h.engine = ENGINE_NAMES[e.kind];
    const live = s ? this.liveOf(s) : undefined;
    if (live !== undefined) h.isLive = live;
    // A VOD session has no live edge: nothing that steers the live delay is reported.
    const steer = live !== false && s?.live !== false;
    // behindLiveS is always the distance to the live edge (what we can steer); the stream clock is display only.
    if (s && e?.kind === 'mpegts') {
      h.tracksBytes = true;
      if (s.lastByteAt !== undefined) h.lastByteAt = s.lastByteAt;
      if (s.live) h.behindLiveSource = 'buffer';
    } else if (s && e?.kind === 'hls') {
      if (s.targetDurationS !== undefined) h.targetDurationS = s.targetDurationS;
      const date = e.hls.playingDate;
      const pdt = date ? (Date.now() - date.getTime()) / 1000 : Number.NaN;
      if (pdt > PDT_MIN_S && pdt < PDT_MAX_S) h.streamClockBehindS = Math.max(0, pdt);
      if (steer && Number.isFinite(e.hls.latency) && e.hls.latency > 0) {
        h.behindLiveS = e.hls.latency;
        h.behindLiveSource = 'edge';
      }
    } else if (e?.kind === 'native' && steer) {
      const sk = v.seekable;
      const end = sk && sk.length > 0 ? sk.end(sk.length - 1) : Number.NaN;
      if (Number.isFinite(end)) {
        h.behindLiveS = Math.max(0, end - v.currentTime);
        h.behindLiveSource = 'edge';
      }
    }
    return h;
  }

  /**
   * Whether the session's stream is live: hls.js from the playlist, the element from its duration (Infinity is live,
   * a finite duration is a file, NaN is not known yet), mpegts.js always (it is opened as live). A session opened as
   * VOD is never live.
   */
  private liveOf(s: Session): boolean | undefined {
    const live = this.rawLiveOf(s);
    if (!s.live) return live; // VOD: never latched live
    if (live === true) s.sawLive = true;
    return s.sawLive ? true : live;
  }

  private rawLiveOf(s: Session): boolean | undefined {
    const e = s.engine;
    if (!e) return undefined;
    // Opened as VOD: never live; a file once its duration is known.
    if (!s.live) return Number.isFinite(this.video.duration) ? false : undefined;
    if (e.kind === 'mpegts') return true;
    if (e.kind === 'hls') return s.hlsLive;
    const d = this.video.duration;
    if (typeof d !== 'number' || Number.isNaN(d)) return undefined;
    return !Number.isFinite(d);
  }

  private emitEos(s: Session): void {
    if (s.eosSent) return;
    s.eosSent = true;
    this.emit(s, 'error', { code: 'EOS', message: EOS_MESSAGE });
  }

  /** After mpegts.js finished downloading: EOS once the buffer ahead drops below `DRAINED_S`. */
  private eosWhenDrained(s: Session, current: () => boolean): void {
    const check = (): boolean => {
      if (!current() || s.eosSent) return true;
      if (this.bufferAhead() >= DRAINED_S) return false;
      this.emitEos(s);
      return true;
    };
    if (check()) return;
    const timer = setInterval(() => { if (check()) clearInterval(timer); }, DRAIN_POLL_MS);
    s.cleanups.push(() => clearInterval(timer));
  }

  /** Seconds buffered ahead of the playhead; before the first range (TS start), the length buffered so far. */
  private bufferAhead(): number {
    const v = this.video;
    const b = v.buffered;
    if (!b || b.length === 0) return 0;
    const t = v.currentTime;
    if (t < b.start(0)) return b.end(b.length - 1) - b.start(0);
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.05 && b.end(i) > t) return b.end(i) - t;
    return 0;
  }

  /** Raw TS: holds `play()` until the preset's start cushion is buffered (or the wait limit passes). */
  private playAfterCushion(s: Session): void {
    const cushion = START_CUSHION_S[this.profile.preset];
    if (cushion <= 0) {
      this.playSession(s);
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (s.dead) {
        clearInterval(timer);
        return;
      }
      if (this.bufferAhead() >= cushion || Date.now() - startedAt >= CUSHION_MAX_WAIT_MS) {
        clearInterval(timer);
        this.playSession(s);
      }
    }, 100);
    s.cleanups.push(() => clearInterval(timer));
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
    if (this.subtitleTimer !== undefined) clearInterval(this.subtitleTimer);
    this.subtitleTimer = undefined;
  }

  private emit(s: Session, state: PlayerState, detail: StateDetail = {}): void {
    if (s.dead || s !== this.session) return;
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
