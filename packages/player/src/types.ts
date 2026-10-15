export type PlayerState = 'idle' | 'loading' | 'playing' | 'buffering' | 'error';
export interface Rect { x: number; y: number; w: number; h: number } // in 1920x1080 design space
export type AspectMode = 'auto' | '16:9' | '4:3' | 'zoom' | 'stretch';
export interface TrackInfo { id: string; label: string; language?: string; active: boolean }
export interface StreamInfo { width?: number; height?: number; videoCodec?: string; audioCodec?: string; bitrate?: number; fps?: number }

/**
 * Why a stream failed. `EOS`: a live stream ended (the server closed it), reconnect at once. `AUTH`: the source
 * refused the stream (HTTP 401/403/410).
 */
export type ErrorCode = 'NETWORK' | 'MEDIA' | 'DECODE' | 'UNSUPPORTED' | 'EOS' | 'AUTH';
export interface StateDetail {
  code?: ErrorCode;
  message?: string;
  attemptId?: number;
  httpStatus?: number;
  /** The engine's own error id (hls.js `details`, mpegts.js detail, AVPlay error name). Diagnostics only; never a URL. */
  detail?: string;
}

/** The engine behind a session, for diagnostics. */
export type EngineName = 'native' | 'hls.js' | 'mpegts.js' | 'avplay';

/**
 * Where `behindLiveS` comes from: the distance to the live edge (what the client can steer), or (raw TS) only the
 * buffer. `'pdt'` (the stream's wall clock) is kept for compatibility; engines report the stream clock separately
 * as `streamClockBehindS`, for display only.
 */
export type LatencySource = 'pdt' | 'edge' | 'buffer';

/** A cheap snapshot for the supervisor's 250 ms tick. Unknown values are left out. */
export interface PlaybackHealth {
  positionMs: number;
  /** The engine playing this session, once chosen. */
  engine?: EngineName;
  /** Seconds buffered ahead of the playhead. */
  bufferAheadS?: number;
  /** Number of disjoint buffered ranges (a gap hint). */
  rangeCount?: number;
  /** Monotonic count of presented video frames. */
  framesPresented?: number;
  /** True when the engine reports network bytes; then `lastByteAt` is set once the first byte has arrived. */
  tracksBytes?: boolean;
  /** Clock ms (Date.now) of the last network byte for this stream. */
  lastByteAt?: number;
  /** Seconds behind the live edge (or, for raw TS, unset: the buffer is the measure). Steers seeks, rate and reopens. */
  behindLiveS?: number;
  /** Set explicitly by the engine; the live delay controller runs only when it is set. */
  behindLiveSource?: LatencySource;
  /** Seconds behind by the stream's own clock (EXT-X-PROGRAM-DATE-TIME), within -5…600 s. Display only. */
  streamClockBehindS?: number;
  /** True for a live stream, false for a file/VOD; left out while unknown. Nothing live-only runs when false. */
  isLive?: boolean;
  /** HLS `EXT-X-TARGETDURATION` in seconds, once known. */
  targetDurationS?: number;
}

export type LivePreset = 'low' | 'balanced' | 'stable';
export interface LiveProfile { preset: LivePreset; targetS: number; allowRate: boolean }
export type RecoverAction = 'gapJump' | 'softReload';

export interface OpenOptions {
  /** False for a file/VOD: engines configure for a finite stream (mpegts.js isLive:false, no live sync). Default true. */
  live?: boolean;
  /** Start position for VOD (ms). Applied once the engine can seek (metadata known). */
  startMs?: number;
}

/**
 * Contract: after `stop()` or a new `open()`, the player must not emit state events for the previous stream.
 * As a second line of defence, `open(url, attemptId)` receives an opaque id from the supervisor and the player
 * should echo it as `detail.attemptId` on every state event it emits for that stream; the supervisor drops events
 * whose `attemptId` does not match the current attempt. Events without an `attemptId` are accepted.
 *
 * The optional members are the live-delay and recovery hooks; an engine implements what it can.
 *
 * A non-live stream (file/VOD) that plays to its end reports `'idle'`: playback is over, nothing reconnects.
 */
export interface Player {
  open(url: string, attemptId?: number, opts?: OpenOptions): Promise<void>; // resolves when loading starts; state events report the progress
  stop(): void;
  setRect(rect: Rect | 'fullscreen'): void;
  setAspect(mode: AspectMode): void;
  audioTracks(): TrackInfo[];
  selectAudioTrack(id: string): void;
  streamInfo(): StreamInfo;
  position(): number; // ms; advances while playing (used by the stall watchdog)
  onState(fn: (s: PlayerState, detail?: StateDetail) => void): () => void;
  destroy(): void;
  /** Cheap snapshot; called every 250 ms while a stream is playing. */
  health?(): PlaybackHealth;
  /** Applies to the next `open()`. */
  setLiveProfile?(p: LiveProfile): void;
  /**
   * Moves the playhead to `targetS` behind live. False only when impossible (the caller reopens); a no-op counts as
   * true, and a non-live stream is always a no-op.
   */
  seekToLive?(targetS: number): boolean;
  /** Only called when the profile allows rate catch-up. */
  setPlaybackRate?(rate: number): void;
  /** In-place recovery that keeps the element and its last frame. False when unsupported. */
  recover?(action: RecoverAction): boolean;
  /** Keeps the current frame visible until the next 'playing' (or `releaseLastFrame`). */
  holdLastFrame?(): void;
  releaseLastFrame?(): void;
  /** VOD controls; engines implement what they can. */
  pause?(): void;
  play?(): void;
  /** Absolute position in ms; clamped by the engine. False when impossible. */
  seek?(ms: number): boolean;
  /** Duration in ms of a finite stream; undefined while unknown or for live. */
  duration?(): number | undefined;
  paused?(): boolean;
  textTracks?(): TrackInfo[];
  /** `null`: subtitles off. */
  selectTextTrack?(id: string | null): void;
}
