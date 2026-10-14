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
export interface StateDetail { code?: ErrorCode; message?: string; attemptId?: number; httpStatus?: number }

/** Where `behindLiveS` comes from: the stream's wall clock, the distance to the live edge, or (raw TS) only the buffer. */
export type LatencySource = 'pdt' | 'edge' | 'buffer';

/** A cheap snapshot for the supervisor's 250 ms tick. Unknown values are left out. */
export interface PlaybackHealth {
  positionMs: number;
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
  behindLiveS?: number;
  behindLiveSource?: LatencySource;
  /** HLS `EXT-X-TARGETDURATION` in seconds, once known. */
  targetDurationS?: number;
}

export type LivePreset = 'low' | 'balanced' | 'stable';
export interface LiveProfile { preset: LivePreset; targetS: number; allowRate: boolean }
export type RecoverAction = 'gapJump' | 'softReload';

/**
 * Contract: after `stop()` or a new `open()`, the player must not emit state events for the previous stream.
 * As a second line of defence, `open(url, attemptId)` receives an opaque id from the supervisor and the player
 * should echo it as `detail.attemptId` on every state event it emits for that stream; the supervisor drops events
 * whose `attemptId` does not match the current attempt. Events without an `attemptId` are accepted.
 *
 * The optional members are the live-delay and recovery hooks; an engine implements what it can.
 */
export interface Player {
  open(url: string, attemptId?: number): Promise<void>; // resolves when loading starts; state events report the progress
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
  /** Moves the playhead to `targetS` behind live. False only when impossible (the caller reopens); a no-op counts as true. */
  seekToLive?(targetS: number): boolean;
  /** Only called when the profile allows rate catch-up. */
  setPlaybackRate?(rate: number): void;
  /** In-place recovery that keeps the element and its last frame. False when unsupported. */
  recover?(action: RecoverAction): boolean;
  /** Keeps the current frame visible until the next 'playing' (or `releaseLastFrame`). */
  holdLastFrame?(): void;
  releaseLastFrame?(): void;
}
