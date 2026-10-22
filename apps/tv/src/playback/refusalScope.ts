/**
 * Who a stream refusal is about (spec 2026-10-20-multiview §5.4). A multiview tile refused while another session of
 * the same host was open is the source saying "not one more stream": only that tile stops, and the host cooldown that
 * would hold every stream of the source does not start. Rate limiting (429, 503) and a refusal of the only session
 * are about the host, as in single view. Pure; the escalation memory lives for the session only.
 */
export type RefusalScope = 'tile' | 'host';

/** What the supervisor knew about the refused attempt: its HTTP status and the other sessions of its host. */
export interface RefusalFacts {
  httpStatus?: number;
  concurrent?: number;
}

/** "Too many requests", not "too many streams": these always cool the host down. */
const HOST_STATUSES: ReadonlySet<number> = new Set([429, 503]);
/** The 4th tile refusal on one host within this window escalates to the host cooldown. */
const ESCALATE_AFTER = 3;
const ESCALATE_WINDOW_MS = 600_000;

export function classifyRefusal(f: RefusalFacts): RefusalScope {
  if (f.httpStatus !== undefined && HOST_STATUSES.has(f.httpStatus)) return 'host';
  return (f.concurrent ?? 0) > 0 ? 'tile' : 'host';
}

export interface RefusalScoper {
  /** The scope of a refusal on `hostKey` (a stream cooldown key); records tile refusals for the escalation. */
  decide(hostKey: string, f: RefusalFacts): RefusalScope;
  /** Tile refusals on `hostKey` within the last 10 min. */
  tileRefusals(hostKey: string): number;
}

export function createRefusalScope(now: () => number = Date.now): RefusalScoper {
  const seen = new Map<string, number[]>();
  const recent = (hostKey: string) => {
    const t = now();
    const list = (seen.get(hostKey) ?? []).filter((at) => t - at < ESCALATE_WINDOW_MS);
    seen.set(hostKey, list);
    return list;
  };
  return {
    decide(hostKey, f) {
      if (classifyRefusal(f) === 'host') return 'host';
      const list = recent(hostKey);
      list.push(now());
      return list.length > ESCALATE_AFTER ? 'host' : 'tile';
    },
    tileRefusals: (hostKey) => recent(hostKey).length,
  };
}
