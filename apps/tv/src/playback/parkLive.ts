import type { Rect } from '@iptv/player';
import { liveToRemember, type LiveReturn } from '../vod/liveReturn.ts';

/**
 * What a screen opened over live playback does with the stream on mount (pure: `parkLiveForScreen.ts` binds the app's
 * playback). `'stop'`: a full screen (Start, StartSports, Movies, Series) stops the live stream (a 1 GB TV needs the
 * decoder and memory) after remembering a channel that plays or is on its way, so Home resumes it on the way back to
 * Live TV. `{ preview }`: a screen with Home's layout (Search) parks a fullscreen video, left by a Player below, in the
 * preview window instead, so the shell's wordmark returns and Home needs no visible move; a video already there stays.
 */
export type ParkLive = 'stop' | { preview: Rect };

export interface ParkLiveDeps {
  currentId(): string | undefined;
  statusKind(): string | undefined;
  rectIsFullscreen(): boolean;
  activeSourceId(): string | undefined;
  stop(): void;
  setRect(rect: Rect): void;
  liveReturn: Pick<LiveReturn, 'remember'>;
}

export function createParkLive(deps: ParkLiveDeps): (how: ParkLive) => void {
  return (how) => {
    if (how === 'stop') {
      deps.liveReturn.remember(liveToRemember(deps.currentId(), deps.statusKind()), deps.activeSourceId());
      deps.stop();
    } else if (deps.rectIsFullscreen()) {
      deps.setRect(how.preview);
    }
  };
}
