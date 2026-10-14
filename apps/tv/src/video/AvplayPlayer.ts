import type {
  AspectMode, Player, PlayerState, Rect, StateDetail, StreamInfo, TrackInfo,
} from '@iptv/player';
import { DESIGN_HEIGHT, DESIGN_WIDTH, FULLSCREEN } from './videoLayer.ts';

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
}

export interface AvplayListener {
  onbufferingstart?: () => void;
  onbufferingprogress?: (percent: number) => void;
  onbufferingcomplete?: () => void;
  oncurrentplaytime?: (ms: number) => void;
  onevent?: (type: string, data: string) => void;
  onerror?: (type: string) => void;
  onstreamcompleted?: () => void;
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

/**
 * AVPlay error (an `onerror` type string, or an exception / prepare error with a `name`) to a player code.
 * Unsupported content or DRM is `UNSUPPORTED` (the supervisor tries the other format); player state faults are
 * `MEDIA`; everything else, including unknown shapes, is `NETWORK` so it is retried.
 */
export function mapAvplayError(e: unknown): 'UNSUPPORTED' | 'NETWORK' | 'MEDIA' {
  const name = typeof e === 'string'
    ? e
    : typeof e === 'object' && e !== null && typeof (e as { name?: unknown }).name === 'string'
      ? (e as { name: string }).name
      : '';
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

/** One `open()`; once `dead`, nothing it registered may emit again. */
interface Session { url: string; attemptId: number | undefined; dead: boolean; started: boolean }

const MESSAGE = 'Playback error';

/**
 * `Player` on Samsung's AVPlay (`webapis.avplay`), used on Tizen. AVPlay draws on a video plane beneath the
 * page (an `<object type="application/avplayer">` must be in the document), positioned with `setDisplayRect`.
 * Every AVPlay call is guarded: a throw becomes an `error` state, never an exception. URLs are never logged
 * or put in messages.
 */
export class AvplayPlayer implements Player {
  private readonly listeners = new Set<(s: PlayerState, d?: StateDetail) => void>();
  private session: Session | undefined;
  private rect: Rect = FULL;
  private aspect: AspectMode = 'auto';
  private lastPosition = 0;
  private readonly space: Size;

  constructor(private readonly avplay: AvplayLike, opts: { displaySpace?: Size } = {}) {
    this.space = opts.displaySpace ?? DESIGN;
  }

  open(url: string, attemptId?: number): Promise<void> {
    this.stop();
    const s: Session = { url, attemptId, dead: false, started: false };
    this.session = s;
    this.lastPosition = 0;
    this.emit(s, 'loading');
    const av = this.avplay;
    try {
      av.open(url);
      av.setListener({
        onbufferingstart: () => this.emit(s, 'buffering'),
        onbufferingcomplete: () => { if (s.started) this.emit(s, 'playing'); },
        oncurrentplaytime: (ms) => { if (!s.dead && typeof ms === 'number') this.lastPosition = ms; },
        onerror: (type) => this.emit(s, 'error', { code: mapAvplayError(type), message: MESSAGE }),
        // A live stream that "completes" has dropped: report it so the supervisor reconnects.
        onstreamcompleted: () => this.emit(s, 'error', { code: 'NETWORK', message: MESSAGE }),
      });
      this.applyDisplay();
      av.prepareAsync(
        () => {
          if (s.dead || s !== this.session) return;
          try {
            this.applyDisplay(); // the source aspect is known now (zoom)
            av.play();
            s.started = true;
            this.emit(s, 'playing');
          } catch (e) {
            this.emit(s, 'error', { code: mapAvplayError(e), message: MESSAGE });
          }
        },
        (e) => this.emit(s, 'error', { code: mapAvplayError(e), message: MESSAGE }),
      );
    } catch (e) {
      this.emit(s, 'error', { code: mapAvplayError(e), message: MESSAGE });
    }
    return Promise.resolve();
  }

  stop(): void {
    const s = this.session;
    if (!s) return;
    s.dead = true;
    this.session = undefined;
    // Separate guards: a failing stop() (e.g. already idle) must not skip close().
    try { this.avplay.stop(); } catch { /* ignore */ }
    try { this.avplay.close(); } catch { /* ignore */ }
  }

  setRect(rect: Rect | 'fullscreen'): void {
    this.rect = rect === 'fullscreen' ? FULL : { ...rect };
    if (this.session) this.applyDisplay();
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
      const language = str(parseExtra(t).language);
      const info: TrackInfo = { id: String(t.index), label: language ?? `Track ${n}`, active: t.index === activeIndex };
      if (language) info.language = language;
      out.push(info);
    }
    return out;
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

  onState(fn: (s: PlayerState, detail?: StateDetail) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  destroy(): void {
    this.stop();
    this.listeners.clear();
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
