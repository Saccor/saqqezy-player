import type { SupervisorStatus } from '@iptv/player';

type Failed = Extract<SupervisorStatus, { kind: 'failed' }>;

/** What the failure text needs: the supervisor's reason and status, and the Xtream account's connection limit when known. */
export interface FailureFacts {
  reason: Failed['reason'];
  httpStatus?: number;
  maxConnections?: number;
}

/**
 * Which screen asks: the Player (`stream`), Home's and the Guide's preview (`channel`) or VodPlay (`video`). Only the
 * unavailable, unsupported and gone texts differ; each keeps that screen's existing wording.
 */
export type FailureSubject = 'stream' | 'channel' | 'video';

const UNAVAILABLE: Record<FailureSubject, string> = {
  stream: "This channel isn't available right now.",
  channel: "This channel isn't available right now.",
  video: "This video can't play right now.",
};
const UNSUPPORTED: Record<FailureSubject, string> = {
  stream: "This stream's format isn't supported on this device.",
  channel: "This channel's format isn't supported on this device.",
  video: "This video format can't play on this device.",
};
const GONE: Record<FailureSubject, string> = {
  stream: "This channel isn't on your source anymore.",
  channel: "This channel isn't on your source anymore.",
  video: "This video isn't on your source anymore.",
};

/** Statuses after which another device on the account is a likely cause (spec §2.8: 401/403, or none known). */
const ACCOUNT_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/** Statuses a source sends when it caps how many or how often (spec §2.8 "Rate limited"). */
const RATE_LIMIT_STATUSES: ReadonlySet<number> = new Set([429, 458, 509]);

/** `text` (ending with a full stop) with " (N)" before it; unchanged when no status is known. */
function withStatus(text: string, status: number | undefined): string {
  return status === undefined ? text : `${text.slice(0, -1)} (${status}).`;
}

/**
 * The text for a failed play (spec 2026-10-16-source-retry §2.8): names the cause and the HTTP status when known.
 * One function for the live Player, the Home and Guide preview, and VodPlay. Neutral: never names a provider.
 */
export function failureText(f: FailureFacts, subject: FailureSubject = 'channel'): string {
  switch (f.reason) {
    case 'refused': {
      if (f.httpStatus !== undefined && RATE_LIMIT_STATUSES.has(f.httpStatus)) {
        return `Your source is limiting connections (${f.httpStatus}).`;
      }
      const base = withStatus('Your source refused this stream.', f.httpStatus);
      const n = f.maxConnections;
      if (f.httpStatus !== undefined && !ACCOUNT_STATUSES.has(f.httpStatus)) return base;
      if (n === undefined || !Number.isInteger(n) || n < 1) return base;
      return `${base} It allows ${n} connection${n === 1 ? '' : 's'}: another device may be using this account.`;
    }
    case 'gone': return withStatus(GONE[subject], f.httpStatus);
    case 'unsupported': return UNSUPPORTED[subject];
    default: return withStatus(UNAVAILABLE[subject], f.httpStatus);
  }
}
