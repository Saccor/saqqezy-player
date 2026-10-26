import type { SupervisorStatus } from '@iptv/player';
import { FAILURE_COPY } from '../copy/failure.ts';

type Failed = Extract<SupervisorStatus, { kind: 'failed' }>;

/** What the failure text needs: the supervisor's reason and status, and the Xtream account's connection limit when known. */
export interface FailureFacts {
  reason: Failed['reason'];
  httpStatus?: number;
  maxConnections?: number;
}

/** Statuses after which another device on the account is a likely cause (spec 2026-10-16 §2.8: 401/403, or none known). */
const ACCOUNT_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/** `text` with " (N)" before its first full stop; unchanged when no status is known. */
function withStatus(text: string, status: number | undefined): string {
  return status === undefined ? text : text.replace('.', ` (${status}).`);
}

/**
 * The text for a failed play: one of five messages (spec 2026-10-26 §1.4) for every screen (Player, previews, VodPlay,
 * multiview windows), with the HTTP status when known and, for an account refusal, the connection limit.
 */
export function failureText(f: FailureFacts): string {
  switch (f.reason) {
    case 'refused': {
      const base = withStatus(FAILURE_COPY.refused, f.httpStatus);
      const n = f.maxConnections;
      const accountLike = f.httpStatus === undefined || ACCOUNT_STATUSES.has(f.httpStatus);
      if (!accountLike || n === undefined || !Number.isInteger(n) || n < 1) return base;
      return `${base} ${FAILURE_COPY.allows(n)}`;
    }
    case 'gone': return withStatus(FAILURE_COPY.tryAnother, f.httpStatus);
    case 'unsupported': return FAILURE_COPY.noPicture;
    default: return withStatus(FAILURE_COPY.unreachable, f.httpStatus);
  }
}
