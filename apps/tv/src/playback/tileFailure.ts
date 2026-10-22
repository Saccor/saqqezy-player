import type { SourceCooldown } from '@iptv/app-api';
import type { FailReason } from '@iptv/player';
import { MULTIVIEW_COPY } from '../copy.ts';
import { COOLDOWN_TEXT, UNREACHABLE_TEXT, tryingAgainIn } from '../state/cooldownLogic.ts';
import { failureText, type FailureFacts } from './failureText.ts';

/**
 * What a multiview window shows after its stream failed (spec 2026-10-20-multiview §2.6, §5.4). It stays in its slot
 * with the reason, Retry and Close window, and is never retried by itself. Retry waits 3 s so a refusal is not
 * answered by a burst of opens. Pure.
 */
export const RETRY_REST_MS = 3000;

export interface TileFailureFacts {
  reason: FailReason;
  httpStatus?: number;
  /** The source's reported connection count (Xtream), when known. */
  maxConnections?: number;
  /** The source cut the oldest stream when this one opened: it seems to allow this many at once. */
  kicked?: number;
  /** The 4th refused window on this host within 10 min: the host cooldown took over. */
  escalated?: boolean;
  /** The TV itself refused a second picture (spec 2026-10-22-tizen-multiview): not the stream, not the source. */
  deviceLimit?: boolean;
  /**
   * The window's stream host (or the source) is cooling down: nothing opens until it ends, so the window says so and
   * offers Retry now (one probe), as the single-view player does. Never a black window.
   */
  cooldown?: SourceCooldown;
  /** When it failed, and now (ms). */
  at: number;
  now: number;
}

export interface TileFailureView {
  text: string;
  retry: { enabled: boolean; inMs: number };
  close: true;
  /** Held by a cooldown: Retry is "Retry now" (one probe of the source), not a reopen. */
  retryNow?: true;
  /** Held by a cooldown: when it tries again by itself ("Trying again in N min"). */
  hint?: string;
}

export function tileFailure(f: TileFailureFacts): TileFailureView {
  // The single-view player's cooldown words; its "OK: Retry now" becomes the window's own action line.
  if (!f.deviceLimit && f.cooldown?.state === 'waiting') {
    const text = f.cooldown.reason === 'unreachable' ? UNREACHABLE_TEXT : COOLDOWN_TEXT;
    return { text, retry: { enabled: true, inMs: 0 }, close: true, retryNow: true, hint: tryingAgainIn(f.cooldown, f.now) };
  }
  const inMs = Math.max(0, f.at + RETRY_REST_MS - f.now);
  let text: string;
  if (f.deviceLimit) text = MULTIVIEW_COPY.deviceLimit;
  else if (f.kicked !== undefined) text = MULTIVIEW_COPY.kicked(f.kicked);
  else if (f.escalated) text = MULTIVIEW_COPY.escalated;
  else {
    const facts: FailureFacts = { reason: f.reason };
    if (f.httpStatus !== undefined) facts.httpStatus = f.httpStatus;
    if (f.maxConnections !== undefined) facts.maxConnections = f.maxConnections;
    text = failureText(facts, 'window');
  }
  return { text, retry: { enabled: inMs === 0, inMs }, close: true };
}
