export type PlayerState = 'idle' | 'loading' | 'playing' | 'buffering' | 'error';
export interface Rect { x: number; y: number; w: number; h: number } // in 1920x1080 design space
export type AspectMode = 'auto' | '16:9' | '4:3' | 'zoom' | 'stretch';
export interface TrackInfo { id: string; label: string; language?: string; active: boolean }
export interface StreamInfo { width?: number; height?: number; videoCodec?: string; audioCodec?: string; bitrate?: number; fps?: number }
export interface Player {
  open(url: string): Promise<void>; // resolves when loading starts; state events report the progress
  stop(): void;
  setRect(rect: Rect | 'fullscreen'): void;
  setAspect(mode: AspectMode): void;
  audioTracks(): TrackInfo[];
  selectAudioTrack(id: string): void;
  streamInfo(): StreamInfo;
  position(): number; // ms; advances while playing (used by the stall watchdog)
  onState(fn: (s: PlayerState, detail?: { code?: string; message?: string }) => void): () => void;
  destroy(): void;
}
