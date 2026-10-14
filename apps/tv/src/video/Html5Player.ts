import Hls, { ErrorDetails, ErrorTypes, type ErrorData } from 'hls.js';
import mpegts from 'mpegts.js';
import type {
  AspectMode, Player, PlayerState, Rect, StateDetail, StreamInfo, TrackInfo,
} from '@iptv/player';
import { hlsViaDevProxy } from '../net/devProxy.ts';
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
  cleanups: (() => void)[];
}

const HLS_MIME = 'application/vnd.apple.mpegurl';
const HLS_CODEC_ERRORS = new Set<string>([
  ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR,
  ErrorDetails.BUFFER_ADD_CODEC_ERROR,
  ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR,
]);

interface NativeAudioTrack { id: string; label: string; language: string; enabled: boolean }
interface NativeAudioTrackList { length: number; [i: number]: NativeAudioTrack }

function pathOf(url: string): string {
  try {
    return new URL(url, location.href).pathname.toLowerCase();
  } catch {
    return url.toLowerCase().split(/[?#]/)[0] ?? '';
  }
}

/**
 * `Player` on an HTML5 `<video>`: native HLS where the platform has it, else hls.js for `.m3u8`;
 * mpegts.js (live) for `.ts`; anything else is handed to the element directly.
 */
export class Html5Player implements Player {
  private readonly video: HTMLVideoElement;
  private readonly listeners = new Set<(s: PlayerState, d?: StateDetail) => void>();
  private session: Session | undefined;

  private readonly preferNativeHls: boolean;

  constructor(private readonly layer: VideoLayer, opts: { preferNativeHls?: boolean } = {}) {
    this.video = layer.video;
    this.preferNativeHls = opts.preferNativeHls ?? true;
  }

  open(url: string, attemptId?: number): Promise<void> {
    this.stop();
    const s: Session = { url, attemptId, dead: false, engine: undefined, cleanups: [] };
    this.session = s;
    const v = this.video;
    const src = hlsViaDevProxy(url);
    const path = pathOf(url);

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
      // MediaError 4 (SRC_NOT_SUPPORTED) before any metadata (HAVE_NOTHING) is a failed load (404, refused,
      // dropped connection), so it is retryable NETWORK; only once metadata has loaded is it really UNSUPPORTED.
      const code = err.code === 4
        ? (v.readyState === 0 ? 'NETWORK' : 'UNSUPPORTED')
        : err.code === 2 ? 'NETWORK' : err.code === 3 ? 'DECODE' : 'MEDIA';
      this.emit(s, 'error', { code, message: 'Playback error' });
    });

    this.emit(s, 'loading');

    if (path.endsWith('.m3u8')) {
      if (this.preferNativeHls && v.canPlayType(HLS_MIME) !== '') {
        s.engine = { kind: 'native' };
        v.src = src;
      } else if (Hls.isSupported()) {
        const hls = new Hls({ lowLatencyMode: false, backBufferLength: 30 });
        s.engine = { kind: 'hls', hls };
        hls.on(Hls.Events.ERROR, (_e, data: ErrorData) => {
          // Non-fatal codec errors (e.g. one unplayable level) are recoverable: only fatal ones, or a manifest
          // with no playable codec at all, are reported.
          if (!data.fatal && data.details !== ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR) return;
          const code = HLS_CODEC_ERRORS.has(data.details)
            ? 'UNSUPPORTED'
            : data.type === ErrorTypes.NETWORK_ERROR ? 'NETWORK' : 'MEDIA';
          this.emit(s, 'error', { code, message: 'Playback error' });
        });
        hls.loadSource(src);
        hls.attachMedia(v);
      } else {
        this.emit(s, 'error', { code: 'UNSUPPORTED', message: 'HLS is not supported here' });
        return Promise.resolve();
      }
    } else if (path.endsWith('.ts')) {
      if (!mpegts.isSupported()) {
        this.emit(s, 'error', { code: 'UNSUPPORTED', message: 'MPEG-TS is not supported here' });
        return Promise.resolve();
      }
      const player = mpegts.createPlayer(
        { type: 'mpegts', isLive: true, url: src },
        { enableWorker: false, lazyLoad: false, liveBufferLatencyChasing: true },
      );
      s.engine = { kind: 'mpegts', player };
      player.on(mpegts.Events.ERROR, (type: string, detail: string) => {
        const unsupported = detail === mpegts.ErrorDetails.MEDIA_CODEC_UNSUPPORTED
          || detail === mpegts.ErrorDetails.MEDIA_FORMAT_UNSUPPORTED;
        const code = unsupported ? 'UNSUPPORTED' : type === mpegts.ErrorTypes.NETWORK_ERROR ? 'NETWORK' : 'MEDIA';
        this.emit(s, 'error', { code, message: 'Playback error' });
      });
      player.attachMediaElement(v);
      player.load();
    } else {
      s.engine = { kind: 'native' };
      v.src = src;
    }

    this.play(s);
    return Promise.resolve();
  }

  private play(s: Session): void {
    this.video.play().catch((err: unknown) => {
      if (s.dead) return;
      // Desktop autoplay policy: without a user gesture only muted playback may start.
      if (err instanceof DOMException && err.name === 'NotAllowedError' && !this.video.muted) {
        this.video.muted = true;
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
    const e = s.engine;
    if (e?.kind === 'hls') {
      e.hls.detachMedia();
      e.hls.destroy();
    } else if (e?.kind === 'mpegts') {
      // Each call is guarded on its own so one failure cannot skip the rest or the element reset below.
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
