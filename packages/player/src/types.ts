export type PlayerState = 'idle' | 'loading' | 'playing' | 'buffering' | 'error';
export interface Rect { x: number; y: number; w: number; h: number } // in 1920x1080 design space
export type AspectMode = 'auto' | '16:9' | '4:3' | 'zoom' | 'stretch';
export interface TrackInfo { id: string; label: string; language?: string; active: boolean }
export interface StreamInfo { width?: number; height?: number; videoCodec?: string; audioCodec?: string; bitrate?: number; fps?: number }
export interface StateDetail { code?: string; message?: string; attemptId?: number }
/**
 * Contract: after `stop()` or a new `open()`, the player must not emit state events for the previous stream.
 * As a second line of defence, `open(url, attemptId)` receives an opaque id from the supervisor and the player
 * should echo it as `detail.attemptId` on every state event it emits for that stream; the supervisor drops events
 * whose `attemptId` does not match the current attempt. Events without an `attemptId` are accepted.
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
}
