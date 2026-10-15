import Hls, { ErrorDetails, ErrorTypes, type ErrorData, type LevelLoadedData } from 'hls.js';
import mpegts from 'mpegts.js';
import type {
  AspectMode, EngineName, LiveProfile, PlaybackHealth, Player, PlayerState, RecoverAction, Rect, StateDetail, StreamInfo, TrackInfo,
} from '@iptv/player';
import { hlsViaDevProxy } from '../net/devProxy.ts';
import { AutoMute } from './autoMute.ts';
import { chooseEngine, nextEngineAfterFailure, type TriedEngine } from './engineChoice.ts';
import { CUSHION_MAX_WAIT_MS, START_CUSHION_S, hlsConfig, mpegtsConfig } from './engineConfig.ts';
import type { VideoLayer } from './videoLayer.ts';

type Engine =
  | { kind: 'native' }
  | { kind: 'hls'; hls: Hls }
  | { kind: 'mpegts'; player: mpegts.Player };

/** One `open()`; once `dead`, nothing it registered may emit again. */
interface Session {
  /** The URL as given to `open()` (before any dev-proxy wrapping). */
  url: string;
  attemptId: number | undefined;
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

/** Refusals (see engineConfig's REFUSED_STATUSES): reported as AUTH, so the supervisor stops and the cooldown starts. */
const AUTH_STATUSES = new Set([401, 403, 410, 429, 458, 503, 509]);
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

  private readonly preferNativeHls: boolean;
  private readonly isTv: boolean;
  private readonly autoMute: AutoMute;
  private profile: LiveProfile = { preset: 'balanced', targetS: 3, allowRate: false };

  constructor(private readonly layer: VideoLayer, opts: { preferNativeHls?: boolean; isTv?: boolean } = {}) {
    this.video = layer.video;
    this.preferNativeHls = opts.preferNativeHls ?? true;
    this.isTv = opts.isTv ?? false;
    this.autoMute = new AutoMute(this.video);
  }

  /**
   * Gives the sound back after an autoplay-policy mute; call it from a keydown. Only a key that really
   * activated the page counts (see `AutoMute.releaseOnGesture`).
   */
  unmuteIfAutoMuted(): void {
    this.autoMute.releaseOnGesture(userActivation());
  }

  open(url: string, attemptId?: number): Promise<void> {
    this.stop();
    // Once the page has had a user gesture, playback with sound is allowed again.
    this.autoMute.releaseIfActivated(userActivation());
    const path = pathOf(url);
    const s: Session = { url, attemptId, dead: false, engine: undefined, extensionless: !path.slice(path.lastIndexOf('/') + 1).includes('.'), tried: [], cleanups: [], mediaRecoveries: 0, lastNetRecoveryAt: Number.NEGATIVE_INFINITY };
    this.session = s;
    const v = this.video;
    v.playbackRate = 1;
    const src = hlsViaDevProxy(url);

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
    // Observe liveness while the stream plays so the latch is set before the server can end it.
    on('durationchange', () => void this.liveOf(s));
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
      preferNativeHls: this.preferNativeHls,
    });
    if (choice.engine === 'none') {
      const message = choice.reason === 'hls' ? 'HLS is not supported here' : 'MPEG-TS is not supported here';
      this.emit(s, 'error', { code: 'UNSUPPORTED', message, detail: 'noEngine' });
      return Promise.resolve();
    }
    if (choice.engine === 'native' && choice.fallback) s.fallback = choice.fallback;
    this.startEngine(s, choice.engine, src);
    if (choice.engine === 'mpegts') this.playAfterCushion(s);
    else this.play(s);
    return Promise.resolve();
  }

  private startEngine(s: Session, kind: 'native' | 'hls' | 'mpegts', src: string): void {
    const v = this.video;
    s.tried.push(kind);
    if (kind === 'native') {
      s.engine = { kind: 'native' };
      v.src = src;
    } else if (kind === 'hls') {
      const hls = new Hls(hlsConfig(this.profile.preset, this.isTv));
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
        if (this.recoverHls(s, hls, network ? 'network' : 'media')) return;
        this.emit(s, 'error', { code: network ? 'NETWORK' : 'MEDIA', message: 'Playback error', detail: data.details });
      });
      hls.loadSource(src);
      hls.attachMedia(v);
    } else {
      const player = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: src }, mpegtsConfig(this.profile.preset, this.isTv));
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
      player.on(mpegts.Events.LOADING_COMPLETE, () => {
        if (current()) this.eosWhenDrained(s, current);
      });
      player.on(mpegts.Events.STATISTICS_INFO, (stats: { speed?: number }) => {
        if (current() && (stats.speed ?? 0) > 0) s.lastByteAt = Date.now();
      });
      player.attachMediaElement(v);
      player.load();
    }
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
    if (this.liveOf(s) === false) return true; // no live edge: seeking "to live" would jump to the end of a file
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
    this.startEngine(s, next, hlsViaDevProxy(s.url));
    this.play(s);
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
      this.startEngine(s, next, hlsViaDevProxy(s.url));
      this.play(s);
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

  private play(s: Session): void {
    this.video.play().catch((err: unknown) => {
      if (s.dead) return;
      // Desktop autoplay policy: without a user gesture only muted playback may start.
      // The mute is remembered and dropped on the next key press (`unmuteIfAutoMuted`).
      if (err instanceof DOMException && err.name === 'NotAllowedError' && this.autoMute.mute()) {
        this.play(s);
      }
      // AbortError (superseded by stop/open) and the rest surface through the element/engine error events.
    });
  }

  stop(): void {
    const s = this.session;
    if (!s) return;
    s.dead = true;
    this.session = undefined;
    for (const c of s.cleanups) c();
    this.teardownEngine(s.engine);
    const v = this.video;
    v.pause();
    v.removeAttribute('src');
    v.load();
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
    return info;
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
    // behindLiveS is always the distance to the live edge (what we can steer); the stream clock is display only.
    if (s && e?.kind === 'mpegts') {
      h.tracksBytes = true;
      if (s.lastByteAt !== undefined) h.lastByteAt = s.lastByteAt;
      h.behindLiveSource = 'buffer';
    } else if (s && e?.kind === 'hls') {
      if (s.targetDurationS !== undefined) h.targetDurationS = s.targetDurationS;
      const date = e.hls.playingDate;
      const pdt = date ? (Date.now() - date.getTime()) / 1000 : Number.NaN;
      if (pdt > PDT_MIN_S && pdt < PDT_MAX_S) h.streamClockBehindS = Math.max(0, pdt);
      if (live !== false && Number.isFinite(e.hls.latency) && e.hls.latency > 0) {
        h.behindLiveS = e.hls.latency;
        h.behindLiveSource = 'edge';
      }
    } else if (e?.kind === 'native' && live !== false) {
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
   * a finite duration is a file, NaN is not known yet), mpegts.js always (it is opened as live).
   */
  private liveOf(s: Session): boolean | undefined {
    const live = this.rawLiveOf(s);
    if (live === true) s.sawLive = true;
    return s.sawLive ? true : live;
  }

  private rawLiveOf(s: Session): boolean | undefined {
    const e = s.engine;
    if (!e) return undefined;
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
      this.play(s);
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
        this.play(s);
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
