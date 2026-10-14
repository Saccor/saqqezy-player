import Hls, { ErrorDetails, ErrorTypes, type ErrorData } from 'hls.js';
import mpegts from 'mpegts.js';
import type {
  AspectMode, Player, PlayerState, Rect, StateDetail, StreamInfo, TrackInfo,
} from '@iptv/player';
import { hlsViaDevProxy } from '../net/devProxy.ts';
import { AutoMute } from './autoMute.ts';
import { chooseEngine, nextEngineAfterFailure, type TriedEngine } from './engineChoice.ts';
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
}

const HLS_MIME = 'application/vnd.apple.mpegurl';
const TS_MIME = 'video/mp2t';
const HLS_CODEC_ERRORS = new Set<string>([
  ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR,
  ErrorDetails.BUFFER_ADD_CODEC_ERROR,
  ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR,
]);

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

  private readonly preferNativeHls: boolean;
  private readonly autoMute: AutoMute;

  constructor(private readonly layer: VideoLayer, opts: { preferNativeHls?: boolean } = {}) {
    this.video = layer.video;
    this.preferNativeHls = opts.preferNativeHls ?? true;
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
    const s: Session = { url, attemptId, dead: false, engine: undefined, extensionless: !path.slice(path.lastIndexOf('/') + 1).includes('.'), tried: [], cleanups: [] };
    this.session = s;
    const v = this.video;
    const src = hlsViaDevProxy(url);

    const on = <K extends keyof HTMLMediaElementEventMap>(type: K, fn: () => void) => {
      v.addEventListener(type, fn);
      s.cleanups.push(() => v.removeEventListener(type, fn));
    };
    on('playing', () => this.emit(s, 'playing'));
    on('waiting', () => this.emit(s, 'buffering'));
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
      this.emit(s, 'error', { code, message: 'Playback error' });
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
      this.emit(s, 'error', { code: 'UNSUPPORTED', message });
      return Promise.resolve();
    }
    if (choice.engine === 'native' && choice.fallback) s.fallback = choice.fallback;
    this.startEngine(s, choice.engine, src);
    this.play(s);
    return Promise.resolve();
  }

  private startEngine(s: Session, kind: 'native' | 'hls' | 'mpegts', src: string): void {
    const v = this.video;
    s.tried.push(kind);
    if (kind === 'native') {
      s.engine = { kind: 'native' };
      v.src = src;
    } else if (kind === 'hls') {
      const hls = new Hls({ lowLatencyMode: false, backBufferLength: 30 });
      s.engine = { kind: 'hls', hls };
      hls.on(Hls.Events.ERROR, (_e, data: ErrorData) => {
        // Non-fatal codec errors (e.g. one unplayable level) are recoverable: only fatal ones, or a manifest
        // with no playable codec at all, are reported.
        if (!data.fatal && data.details !== ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR) return;
        // After mpegts.js rejected the stream, a manifest that hls.js cannot parse means neither engine fits.
        const code = HLS_CODEC_ERRORS.has(data.details)
          || (s.tried.includes('mpegts') && data.details === ErrorDetails.MANIFEST_PARSING_ERROR)
          ? 'UNSUPPORTED'
          : data.type === ErrorTypes.NETWORK_ERROR ? 'NETWORK' : 'MEDIA';
        this.emit(s, 'error', { code, message: 'Playback error' });
      });
      hls.loadSource(src);
      hls.attachMedia(v);
    } else {
      const player = mpegts.createPlayer(
        { type: 'mpegts', isLive: true, url: src },
        { enableWorker: false, lazyLoad: false, liveBufferLatencyChasing: true },
      );
      s.engine = { kind: 'mpegts', player };
      player.on(mpegts.Events.ERROR, (type: string, detail: string) => {
        // Nothing from a torn-down instance (stale session or already swapped for the HLS retry) may surface.
        if (s.dead || s.engine?.kind !== 'mpegts' || s.engine.player !== player) return;
        const formatError = detail === mpegts.ErrorDetails.MEDIA_FORMAT_ERROR
          || detail === mpegts.ErrorDetails.MEDIA_FORMAT_UNSUPPORTED;
        if (formatError && this.video.readyState === 0 && this.retryAsHls(s)) return;
        const unsupported = detail === mpegts.ErrorDetails.MEDIA_CODEC_UNSUPPORTED
          || detail === mpegts.ErrorDetails.MEDIA_FORMAT_UNSUPPORTED;
        const code = unsupported ? 'UNSUPPORTED' : type === mpegts.ErrorTypes.NETWORK_ERROR ? 'NETWORK' : 'MEDIA';
        this.emit(s, 'error', { code, message: 'Playback error' });
      });
      player.attachMediaElement(v);
      player.load();
    }
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

  /** mpegts.js rejected an extensionless URL as non-MPEG-TS before metadata: retry the same URL once as HLS. */
  private retryAsHls(s: Session): boolean {
    const next = nextEngineAfterFailure(s.extensionless ? '' : '.', s.tried, 'format', {
      nativeHls: this.video.canPlayType(HLS_MIME) !== '',
      hlsJs: Hls.isSupported(),
    });
    if (!next) return false;
    this.teardownEngine(s.engine);
    s.engine = undefined;
    const v = this.video;
    v.removeAttribute('src');
    v.load();
    this.startEngine(s, next, hlsViaDevProxy(s.url));
    this.play(s);
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
      if (mi?.audioCodec) info.audioCodec = mi.audioCodec;
      if (mi?.fps) info.fps = mi.fps;
    }
    return info;
  }

  position(): number {
    return this.video.currentTime * 1000;
  }

  onState(fn: (s: PlayerState, detail?: StateDetail) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  destroy(): void {
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
