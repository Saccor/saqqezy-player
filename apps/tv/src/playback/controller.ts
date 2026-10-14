import { createSignal, type Accessor } from 'solid-js';
import type { PlayableChannel } from '@iptv/app-api';
import type { Player, PlaybackSupervisor, Rect, SupervisorStatus } from '@iptv/player';

export interface PlaybackController {
  /**
   * Plays `ch` through the supervisor (which stops the old stream before opening the next). Returns false and
   * does nothing when `ch` is already the current channel and has not failed: the stream keeps running, so
   * moving from the preview to fullscreen never reconnects.
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
  status: Accessor<SupervisorStatus | undefined>;
  current: Accessor<PlayableChannel | undefined>;
}

/** Testable core of the `playback` singleton: one player, one supervisor, two signals. */
export function createPlaybackController(
  player: Pick<Player, 'setRect'>,
  supervisor: Pick<PlaybackSupervisor, 'play' | 'stop' | 'onStatus'>,
  onStatusChange: (s: SupervisorStatus | undefined) => void = () => { /* no listener */ },
): PlaybackController {
  const [status, setStatus] = createSignal<SupervisorStatus | undefined>(undefined);
  const [current, setCurrent] = createSignal<PlayableChannel | undefined>(undefined);
  const report = (s: SupervisorStatus | undefined) => {
    setStatus(s);
    onStatusChange(s);
  };
  supervisor.onStatus((s) => report(s));
  let token = 0;

  return {
    playChannel(ch) {
      const cur = current();
      if (cur?.id === ch.id && status()?.kind !== 'failed') return false;
      setCurrent(ch);
      supervisor.play(ch.url, ch.alternateUrl);
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
    setRect: (rect) => player.setRect(rect),
    status,
    current,
  };
}
