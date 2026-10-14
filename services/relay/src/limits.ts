// Relay limits and small pure helpers. See Plan 4 Global Constraints and spec §5.
// Privacy: nothing here logs anything. IP keys live in memory only.

export const LIMITS = {
  /** Max size of one frame on the wire. */
  maxFrameBytes: 300 * 1024,
  /** Max frames per socket per rate window. */
  maxFramesPerWindow: 200,
  rateWindowMs: 10_000,
  /** A session lives at most this long from creation. */
  sessionTtlMs: 15 * 60_000,
  /** A session ends after this long without frames. */
  idleTimeoutMs: 5 * 60_000,
  /** Reconnect queue, per destination role. */
  queueMaxBytes: 2 * 1024 * 1024,
  queueMaxAgeMs: 60_000,
  /** New sessions per IP per window (worker level, in memory only). */
  newSessionsPerIp: 10,
  newSessionWindowMs: 60_000,
} as const;

export type Limits = { readonly [K in keyof typeof LIMITS]: number };

export const CLOSE = {
  EXPIRED: 4000,
  REPLACED: 4001,
  TOO_LARGE: 4002,
  RATE_LIMIT: 4003,
  BAD_ROLE: 4004,
} as const;

export type Role = 'tv' | 'phone';

export function isRole(x: unknown): x is Role {
  return x === 'tv' || x === 'phone';
}

/**
 * A session id is 16 bytes as canonical base64url: 22 characters, no padding, and the last
 * character carries only 2 significant bits (the 4 trailing bits must be zero).
 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{21}[AQgw]$/;
export function isSessionId(s: string): boolean {
  return SESSION_ID_RE.test(s);
}

export function parseAllowedOrigins(csv: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (csv ?? '').split(',')) {
    const o = part.trim();
    if (o) out.add(o);
  }
  return out;
}

/**
 * Origin rules: a listed origin is allowed for both roles. A packaged TV app may send
 * `Origin: null` or `file://`, or no Origin at all; those are allowed only for `role=tv`.
 */
export function originAllowed(origin: string | null, role: Role, allowed: ReadonlySet<string>): boolean {
  if (origin === null || origin === 'null' || origin.startsWith('file://')) return role === 'tv';
  return allowed.has(origin);
}

/**
 * Sliding-window counter per key, in memory only. Used per IP for new sessions; keys are never
 * logged or persisted. Memory is bounded by `maxKeys`: when full, stale keys are pruned, and if
 * still full the oldest-inserted keys are dropped.
 */
export class IpRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  get size(): number { return this.hits.size; }

  allow(key: string, now: number): boolean {
    const cutoff = now - this.windowMs;
    let list = this.hits.get(key);
    if (list) {
      while (list.length > 0 && (list[0] as number) <= cutoff) list.shift();
    } else {
      if (this.hits.size >= this.maxKeys) this.prune(now);
      list = [];
      this.hits.set(key, list);
    }
    if (list.length >= this.max) return false;
    list.push(now);
    return true;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [k, list] of this.hits) {
      if (list.length === 0 || (list[list.length - 1] as number) <= cutoff) this.hits.delete(k);
    }
    // Still full: drop the oldest-inserted keys (Map iterates in insertion order).
    for (const k of this.hits.keys()) {
      if (this.hits.size < this.maxKeys) break;
      this.hits.delete(k);
    }
  }
}

/**
 * Session ids this isolate has routed recently (within the session TTL), in memory only. A
 * connection to a known id is a join or reconnect, not a new session, so it does not count against
 * the per-IP new-session limit. Never stored alongside IPs. Bounded by `maxKeys`.
 */
export class RecentSessions {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs: number, private readonly maxKeys = 50_000) {}

  get size(): number { return this.seen.size; }

  has(id: string, now: number): boolean {
    const at = this.seen.get(id);
    if (at === undefined) return false;
    if (now - at >= this.ttlMs) { this.seen.delete(id); return false; }
    return true;
  }

  add(id: string, now: number): void {
    if (this.seen.has(id)) return; // keep the first-seen time: the TTL runs from creation
    if (this.seen.size >= this.maxKeys) {
      for (const [k, at] of this.seen) if (now - at >= this.ttlMs) this.seen.delete(k);
      for (const k of this.seen.keys()) {
        if (this.seen.size < this.maxKeys) break;
        this.seen.delete(k);
      }
    }
    this.seen.set(id, now);
  }
}
