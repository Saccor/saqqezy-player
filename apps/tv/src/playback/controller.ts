import { createSignal, type Accessor } from 'solid-js';
import type { PlayableChannel } from '@iptv/app-api';
import type { Player, PlaybackSupervisor, Rect, SupervisorStatus } from '@iptv/player';

export interface PlaybackController {
  /**
   * Plays `ch` through the supervisor (which stops the old stream before opening the next). Returns false when
   * `ch` is already the current channel and has not failed: the stream keeps running, so moving from the
   * preview to fullscreen never reconnects; only `current`'s info (name, now/next) is refreshed from `ch`.
   */
  playChannel(ch: PlayableChannel): boolean;
  /** Stops the stream and supersedes every pending request (see `begin`). */
  stop(): void;
  /**
   * Starts a play request and returns its token; a later `begin()` or `stop()` supersedes it. Callers that
   * await something (e.g. `getPlayable`) before `playChannel` check `isLatest(token)` first, so a slow answer
   * for an older request never replaces the channel the user asked for since.
   */
  begin(): number;
  isLatest(token: number): boolean;
  /** Moves the video only; never touches the stream. */
  setRect(rect: Rect | 'fullscreen'): void;
  /** True while the last `setRect` covered the whole screen (false until a screen asks for fullscreen). */
  rectIsFullscreen: Accessor<boolean>;
  /** Which player is active ("AVPlay" on a Samsung TV, else "HTML5"); shown in Diagnostics so a silent fallback is visible. */
  playerKind(): PlayerKind;
  status: Accessor<SupervisorStatus | undefined>;
  current: Accessor<PlayableChannel | undefined>;
}

export type PlayerKind = 'AVPlay' | 'HTML5';

const DESIGN_W = 1920;
const DESIGN_H = 1080;

function coversScreen(rect: Rect | 'fullscreen'): boolean {
  return rect === 'fullscreen' || (rect.x <= 0 && rect.y <= 0 && rect.x + rect.w >= DESIGN_W && rect.y + rect.h >= DESIGN_H);
}

/**
 * Testable core of the `playback` singleton: one player, one supervisor, two signals. `sourceKey` returns the
 * active source id (opaque, never a URL); it keys the learned live delay.
 */
export function createPlaybackController(
  player: Pick<Player, 'setRect'>,
  supervisor: Pick<PlaybackSupervisor, 'play' | 'stop' | 'onStatus'>,
  onStatusChange: (s: SupervisorStatus | undefined) => void = () => { /* no listener */ },
  kind: PlayerKind = 'HTML5',
  sourceKey: () => string | undefined = () => undefined,
): PlaybackController {
  const [status, setStatus] = createSignal<SupervisorStatus | undefined>(undefined);
  const [current, setCurrent] = createSignal<PlayableChannel | undefined>(undefined);
  const [rectIsFullscreen, setRectIsFullscreen] = createSignal(false);
  const report = (s: SupervisorStatus | undefined) => {
    setStatus(s);
    onStatusChange(s);
  };
  supervisor.onStatus((s) => report(s));
  let token = 0;

  return {
    playChannel(ch) {
      const cur = current();
      if (cur?.id === ch.id && status()?.kind !== 'failed') {
        // Same stream: keep it running, but take the fresh info (a rename, now/next). The urls stay those of
        // the open stream.
        if (cur !== ch) {
          const next: PlayableChannel = { ...ch, url: cur.url };
          if (cur.alternateUrl !== undefined) next.alternateUrl = cur.alternateUrl;
          else delete next.alternateUrl;
          setCurrent(next);
        }
        return false;
      }
      setCurrent(ch);
      supervisor.play(ch.url, ch.alternateUrl, { sourceKey: sourceKey() });
      return true;
    },
    stop() {
      token++;
      supervisor.stop();
      setCurrent(undefined);
      report(undefined);
    },
    begin: () => ++token,
    isLatest: (t) => t === token,
    setRect: (rect) => {
      player.setRect(rect);
      setRectIsFullscreen(coversScreen(rect));
    },
    rectIsFullscreen,
    playerKind: () => kind,
    status,
    current,
  };
}
