import type { LiveSourceView, PlayableChannel } from '@iptv/app-api';
import type { FailReason } from '@iptv/player';

/**
 * Failover between the streams of a combined channel (spec 2026-10-19-live-grouping §5). Pure decisions; the playback
 * controller runs them.
 */

/** Streams tried after the first one, per tune (a user action: OK, a zap, Choose source, Last channel, Retry). */
export const MAX_FAILOVERS = 2;

/**
 * A failure another stream of the channel may not have. A refusal is about the account, not the stream: the
 * refusal cooldown runs and no other stream is tried.
 */
export function canFailOver(reason: FailReason): boolean {
  return reason === 'unavailable' || reason === 'gone' || reason === 'unsupported';
}

/** The next stream to try: the first in `sources` not tried and whose host is not waiting; undefined when none or capped. */
export function nextSource(
  sources: readonly LiveSourceView[] | undefined, tried: ReadonlySet<string>, failovers: number,
): string | undefined {
  if (!sources || failovers >= MAX_FAILOVERS) return undefined;
  return sources.find((s) => !tried.has(s.id) && !s.blocked)?.id;
}

/** What the controller needs from the worker and the UI to fail over. */
export interface FailoverDeps {
  /** The stream `channelId` exactly (`api.getPlayable(id, { exact: true })`). */
  fetch(channelId: string): Promise<PlayableChannel | undefined>;
  /** `channelId` failed to play (`api.reportSourceFailed`): it sorts last for a while. */
  failed(channelId: string): void;
  /** Another stream of the channel is starting (the player shows "Switched to another source"). */
  switched?(ch: PlayableChannel): void;
}
