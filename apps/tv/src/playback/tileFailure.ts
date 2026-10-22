import type { FailReason } from '@iptv/player';
import { MULTIVIEW_COPY } from '../copy.ts';
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
  /** When it failed, and now (ms). */
  at: number;
  now: number;
}

export interface TileFailureView {
  text: string;
  retry: { enabled: boolean; inMs: number };
  close: true;
}

export function tileFailure(f: TileFailureFacts): TileFailureView {
  const inMs = Math.max(0, f.at + RETRY_REST_MS - f.now);
  let text: string;
  if (f.kicked !== undefined) text = MULTIVIEW_COPY.kicked(f.kicked);
  else if (f.escalated) text = MULTIVIEW_COPY.escalated;
  else {
    const facts: FailureFacts = { reason: f.reason };
    if (f.httpStatus !== undefined) facts.httpStatus = f.httpStatus;
    if (f.maxConnections !== undefined) facts.maxConnections = f.maxConnections;
    text = failureText(facts, 'window');
  }
  return { text, retry: { enabled: inMs === 0, inMs }, close: true };
}
